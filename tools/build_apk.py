#!/usr/bin/env python3
"""Build a signed, debug-key FamilyShield APK without Gradle.

Pipeline: aapt2 compile -> merge AAR manifests + res/ overlays -> aapt2 link
          (-A assets) -> javac -> d8 -> zip classes.dex -> zipalign -> apksigner.
          Stdlib only; the Android SDK is located from ANDROID_SDK_ROOT/ANDROID_HOME
          or --sdk.

Firebase Messaging (and the transitive AAR classes it needs) is compiled and
dexed straight from the vendored tree in .deps/firebase/, which is filled in by
tools/fetch_firebase_deps.py. That tree stands in for the AAR resolution an
AAR-aware Gradle build would do, so this script stays the only build system.
Two things Gradle does with an AAR that unpacking alone does not provide are
performed here as well, both driven by closure.json:

    * manifest-merger -- the AAR AndroidManifest.xml files are merged into the
      app manifest (components merged by android:name, <meta-data> unioned,
      <application> attributes filled in from the libraries, ${applicationId}
      expanded, tools: attributes dropped), which is what makes
      FirebaseInitProvider, ComponentDiscoveryService and the
      "com.google.firebase.components:*" registrars visible to the runtime;
    * resource overlays -- each AAR res/ dir is aapt2-compiled separately and
      linked after the libraries, before the app, so the app keeps precedence.

Firebase runtime configuration is generated, not hand-copied: google-services.json
is read from outside app/res/, the client matching the manifest package is
selected, and its values are written to build/firebase-res/values/values.xml and
linked into resources.arsc -- the same substitution the google-services Gradle
plugin performs. See the "google-services.json -> Firebase runtime resources"
section below.

Usage:
    python tools/build_apk.py [--sdk C:\\path\\to\\android-sdk] [--out dist]
                             [--no-deps] [--google-services PATH] [--require-fcm]
"""

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
BUILD = ROOT / "build"
DEFAULT_SDK = Path(r"C:\Users\Mohd Arshad Ali\AppData\Local\Tenzy\cache\android-sdk")

# Vendored dependency closure for Firebase Messaging: plain jars extracted from
# the AARs, plus the manifests/res dirs and a closure.json manifest of what was
# resolved. Committed alongside the app, so a build never needs the network.
DEPS = ROOT / ".deps" / "firebase"
DEPS_JARS = DEPS / "jars"
DEPS_RES = DEPS / "res"
DEPS_MANIFESTS = DEPS / "manifests"
DEPS_CLOSURE = DEPS / "closure.json"

MIN_SDK = 24
TARGET_SDK = 34
# Single source of truth for the package version: the aapt2 link step and the
# output filename both read these, so a bump can never desync the two.
VERSION_CODE = "10"
VERSION_NAME = "1.9"
# Bytecode level handed to d8. Kept at 8 so javac emits no NestHost/NestMembers
# attributes: R8 8.2.2 (build-tools 34) crashes with an NPE on JDK 21+ output.
JAVA_RELEASE = int(os.environ.get("FS_JAVA_RELEASE", "8"))


def log(msg):
    print(f"[build] {msg}", flush=True)


def die(msg):
    print(f"[build] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def run(cmd, **kw):
    printable = " ".join(str(c) for c in cmd)
    log(printable if len(printable) <= 400 else printable[:400] + " ...")
    proc = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, **kw)
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.returncode != 0:
        if proc.stderr.strip():
            print(proc.stderr.strip(), file=sys.stderr)
        die(f"command failed ({proc.returncode}): {printable}")
    return proc


def find_sdk(explicit):
    candidates = [explicit, os.environ.get("ANDROID_SDK_ROOT"), os.environ.get("ANDROID_HOME"), DEFAULT_SDK]
    for c in candidates:
        if c and (Path(c) / "build-tools").is_dir() and (Path(c) / "platforms").is_dir():
            return Path(c)
    die("Android SDK not found. Install build-tools + a platform, or pass --sdk.")


def version_key(name):
    return [int(p) if p.isdigit() else 0 for p in re.split(r"[.-]", name)]


def newest(parent, predicate):
    if not parent.is_dir():
        return None
    dirs = [d for d in parent.iterdir() if d.is_dir() and predicate(d)]
    return max(dirs, key=lambda d: version_key(d.name)) if dirs else None


def tool(build_tools, stem):
    for ext in (".exe", ".bat", ".cmd", ""):
        p = build_tools / (stem + ext)
        if p.is_file():
            return p
    die(f"{stem} not found in {build_tools}")


# --- dependency closure ----------------------------------------------------
# AARs were turned into plain jars by tools/fetch_firebase_deps.py; from here on
# they are ordinary d8 program input, which is exactly what a Gradle build would
# dex. Two cleaning steps are still needed before d8 will accept the tree, both
# handled below without touching the downloaded files.

# Kotlin-multiplatform libraries publish a metadata root artefact next to the
# real one (annotation + annotation-jvm, okio + okio-jvm, ...). The root jar
# carries .knm metadata and no bytecode at all, so a jar with no .class entry is
# dropped rather than handed to d8.
# The artefact that carries usable classes on Android wins any class collision.
_PLATFORM_SUFFIXES = ("-jvm", "-android")


def _artifact_name(path):
    """okio-jvm-3.4.0.jar -> 'okio-jvm' (stem minus trailing version)."""
    return re.sub(r"-\d[\w.\-]*$", "", Path(path).stem)


def _platform_rank(path):
    """0 = platform variant of a multiplatform library, 1 = anything else."""
    return 0 if _artifact_name(path).endswith(_PLATFORM_SUFFIXES) else 1


def _closure_artifacts():
    """[{coord, jar, res, manifest}] from closure.json, in resolution order.

    closure.json is written by tools/fetch_firebase_deps.py and records, per
    resolved coordinate, the extracted jar plus the AAR's res/ dir and
    manifests/<coord>.xml. Nothing about the tree is hardcoded here: whatever
    coordinates the fetcher resolved are what gets compiled, dexed and merged,
    so adding a dependency to the fetcher is enough to make it build.
    Returns None when the whole tree is absent (-> --no-deps territory).
    """
    if not DEPS.is_dir():
        return None
    artifacts = []
    if DEPS_CLOSURE.is_file():
        try:
            closure = json.loads(DEPS_CLOSURE.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            die(f"cannot read {DEPS_CLOSURE}: {exc}")
        for art in closure.get("artifacts", []):
            if not isinstance(art, dict):
                continue
            jar = art.get("jar")
            coord = art.get("coord") or (Path(jar).stem if jar else "")
            artifacts.append({
                "coord": coord,
                "jar": (DEPS / jar) if jar else None,
                "res": (DEPS / art["res"]) if art.get("res") else None,
                "manifest": (DEPS / art["manifest"]) if art.get("manifest") else None,
            })
    if not artifacts:                    # no closure.json: trust the layout on disk
        jars = sorted(DEPS_JARS.glob("*.jar")) if DEPS_JARS.is_dir() else []
        for path in jars:
            res_dir = DEPS_RES / path.stem
            manifest = DEPS_MANIFESTS / (path.stem + ".xml")
            artifacts.append({
                "coord": path.stem,
                "jar": path,
                "res": res_dir if res_dir.is_dir() else None,
                "manifest": manifest if manifest.is_file() else None,
            })
    return artifacts or None


def _declared_jars():
    """[(coord, path)] of the dependency tree in resolution order, or None if absent."""
    artifacts = _closure_artifacts()
    if artifacts is None:
        return None
    listed = [(a["coord"], a["jar"]) for a in artifacts if a["jar"]]
    absent = [p.name for _, p in listed if not p.is_file()]
    if absent:
        die("dependency jar(s) missing, re-run tools/fetch_firebase_deps.py: "
            + ", ".join(absent[:4]) + (" ..." if len(absent) > 4 else ""))
    return listed


def dependency_assets():
    """[(coord, res_dir)], [(coord, manifest)] for every AAR in the closure.

    Every artefact on the runtime classpath contributes its manifest and its
    res/ overlay, which is exactly the set Gradle would hand to the manifest
    merger and to aapt2 -- including jars that carry no bytecode (a metadata
    AAR can still ship a manifest, e.g. a manifest-only dependency), which is
    why this reads the closure rather than the post-dedupe jar list.
    """
    artifacts = _closure_artifacts()
    if artifacts is None:
        die(f"Firebase dependency tree not found at {DEPS}; run "
            "'python tools/fetch_firebase_deps.py', or pass --no-deps")
    res_dirs, manifests, absent = [], [], []
    for art in artifacts:
        if art["res"] is not None:
            if art["res"].is_dir():
                res_dirs.append((art["coord"], art["res"]))
            else:
                absent.append(str(art["res"]))
        if art["manifest"] is not None:
            if art["manifest"].is_file():
                manifests.append((art["coord"], art["manifest"]))
            else:
                absent.append(str(art["manifest"]))
    if absent:
        die("vendored AAR asset(s) missing, re-run tools/fetch_firebase_deps.py: "
            + ", ".join(sorted(absent)[:4]) + (" ..." if len(absent) > 4 else ""))
    return res_dirs, manifests


def dependency_jars(out_dir):
    """Resolve .deps/firebase into the jar list to compile and dex against.

    Returns the jars in class-claiming order, which is also the order javac and
    d8 receive them. Jars that need trimming are copied into `out_dir` (inside
    build/, wiped every run) so the downloaded tree stays pristine.
    """
    listed = _declared_jars()
    if listed is None:
        die(f"Firebase dependency tree not found at {DEPS_JARS}; run "
            "'python tools/fetch_firebase_deps.py', or pass --no-deps to build "
            "the shell without Firebase Messaging classes")
    selected, owners, metadata_only, dropped = [], {}, [], 0
    for _coord, path in sorted(listed, key=lambda item: _platform_rank(item[1])):
        try:
            with zipfile.ZipFile(path) as zf:
                entries = zf.namelist()
        except (zipfile.BadZipFile, OSError):
            die(f"{path} is not a readable jar, re-run tools/fetch_firebase_deps.py")
        code = [n for n in entries
                if n.endswith(".class") and not n.startswith("META-INF/")
                and not n.endswith("module-info.class")]
        if not code:
            metadata_only.append(path.name)
            continue
        taken = {n for n in code if n in owners}
        if taken:
            # "Type X is defined multiple times" otherwise; keep the first claim
            # (platform variants are ordered first) and drop the rest.
            log(f"dedupe     {path.name}: {len(taken)} duplicate class(es) already "
                f"in {Path(owners[sorted(taken)[0]]).name}")
            out_dir.mkdir(parents=True, exist_ok=True)
            trimmed = out_dir / path.name
            with zipfile.ZipFile(path) as src, \
                    zipfile.ZipFile(trimmed, "w", zipfile.ZIP_DEFLATED) as dst:
                for name in entries:
                    if name not in taken:
                        dst.writestr(src.getinfo(name), src.read(name))
            dropped += len(taken)
            path = trimmed
            code = [n for n in code if n not in taken]
        for name in code:
            owners.setdefault(name, str(path))
        selected.append(path)

    if metadata_only:
        shown = ", ".join(sorted(metadata_only)[:6])
        log(f"deps       skipped {len(metadata_only)} metadata-only jar(s): {shown}"
            + (" ..." if len(metadata_only) > 6 else ""))
    log(f"deps       {len(selected)} jar(s), {len(owners):,} class(es) for javac/d8"
        + (f", {dropped} duplicate class(es) dropped" if dropped else ""))
    if not selected:
        die(f"no bytecode found under {DEPS_JARS}, re-run tools/fetch_firebase_deps.py")
    return selected


# --- AAR res/ overlays -----------------------------------------------------
# aapt2 has no notion of "libraries" on the command line: Gradle compiles each
# AAR's res/ dir separately and passes every archive to `aapt2 link` with
# --auto-add-overlay, dependency archives first and the app last. The last
# definition of a resource name wins, which is the precedence AGP gives the app.
# The same is done here, one archive per closure entry.

# <resources> children that declare a resource by name; eat-comment/public/
# symbol/... are bookkeeping and are skipped (aapt2 ignores them).
_VALUE_TAGS = {"string", "color", "dimen", "bool", "integer", "fraction", "style",
               "array", "string-array", "integer-array", "plurals", "attr",
               "declare-styleable", "item", "drawable", "macro"}
_VALUE_BOOKKEEPING = {"eat-comment", "public", "public-group", "java-symbol",
                      "symbol", "add-resource", "skip", "overlayable", "staging-public-group"}


def _local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _value_resource_keys(path):
    keys = set()
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError):
        return keys
    for el in root:
        tag, name = _local(el.tag), el.get("name")
        if not name or tag in _VALUE_BOOKKEEPING or tag not in _VALUE_TAGS:
            continue
        kind = el.get("type") if tag == "item" else tag
        keys.add(("values", f"{kind}/{name}"))
    return keys


def _resource_keys(res_dir):
    """{('layout','x'), ('values','string/y'), ...} defined by a res/ tree."""
    keys = set()
    for path in Path(res_dir).rglob("*"):
        if not path.is_file() or path.name.startswith("."):
            continue
        kind = path.parent.name.split("-")[0]       # values-night -> values
        if kind == "values":
            keys |= _value_resource_keys(path)
        else:
            keys.add((kind, path.stem))
    return keys


def report_overlay_precedence(res_dirs, app_res):
    """Log what the overlay order means, so a clash is visible in the build log."""
    app_keys = _resource_keys(app_res)
    owners, clashes, shadowed = {}, set(), set()
    for coord, res_dir in res_dirs:
        for key in _resource_keys(res_dir):
            if key in app_keys:
                shadowed.add(key)
            owner = owners.setdefault(key, coord)
            if owner != coord:
                clashes.add(key)
    log(f"res        {len(res_dirs)} res/ overlay(s), {len(owners):,} resource name(s)")
    if clashes:
        log(f"res        {len(clashes)} name(s) shipped by several AARs (first wins): "
            + ", ".join(f"{t}/{n}" for t, n in sorted(clashes)[:4]))
    if shadowed:
        log(f"res        app overrides {len(shadowed)} library resource(s): "
            + ", ".join(f"{t}/{n}" for t, n in sorted(shadowed)[:4]))


def compile_dependency_resources(aapt2, res_dirs, out_dir):
    """aapt2 compile each AAR res/ dir into its own .zip; returns [(coord, zip)]."""
    out_dir.mkdir(parents=True, exist_ok=True)
    archives, empty = [], []
    for coord, res_dir in res_dirs:
        if not any(p.is_file() for p in Path(res_dir).rglob("*")):
            empty.append(coord)
            continue
        archive = out_dir / (re.sub(r"[^\w.\-]+", "-", coord) + ".zip")
        run([aapt2, "compile", "--dir", res_dir, "-o", archive])
        archives.append((coord, archive))
    if empty:
        log(f"res        {len(empty)} AAR res/ dir(s) are empty: "
            + ", ".join(sorted(empty)[:6]) + (" ..." if len(empty) > 6 else ""))
    return archives


# --- google-services.json -> Firebase runtime resources --------------------
# The com.google.gms.google-services Gradle plugin has exactly one build-time
# job: turn google-services.json into res/values/values.xml, because
# FirebaseOptions.fromResource() resolves its configuration by *resource name*
# (string/google_app_id, string/gcm_defaultSenderId, string/project_id,
# string/google_api_key, ...). Without those strings firebase-messaging is only
# dead bytecode: FirebaseApp never initialises, so FirebaseMessaging.getToken()
# throws "Default FirebaseApp is not initialized in this process" no matter how
# many messaging classes were dexed in.
#
# There is no plugin here, so the substitution is done directly:
#   * the file is read from outside app/res/ (it is deployment configuration for
#     a real project, not a hand-maintained resource) in this order:
#     --google-services, $FS_GOOGLE_SERVICES_JSON, app/google-services.json,
#     <repo>/google-services.json;
#   * the client whose client_info.android_client_info.package_name equals the
#     applicationId declared in app/AndroidManifest.xml is selected, so a
#     multi-client file can never bind the APK to another package's project;
#   * the values are written to build/firebase-res/values/values.xml and compiled
#     into their own aapt2 archive, i.e. they travel through the normal link step
#     into resources.arsc instead of being copied into app/res by hand.
#
# Nothing is invented and nothing is guessed: a file that does not name the app's
# package, a client without an api_key, or a blank project_number is a hard
# error, and the strings are verified back out of the linked APK.

GOOGLE_SERVICES_ENV = "FS_GOOGLE_SERVICES_JSON"
GOOGLE_SERVICES_FILES = (APP / "google-services.json", ROOT / "google-services.json")

# android resource name -> the google-services.json field it must come from.
# The first four are what FirebaseOptions/FirebaseMessaging actually dereference;
# the rest are emitted when present and omitted when absent (FirebaseOptions
# treats them as optional), rather than being written as empty strings.
_FIREBASE_REQUIRED = {
    "google_app_id": "client_info.mobilesdk_app_id",
    "gcm_defaultSenderId": "project_info.project_number",
    "project_id": "project_info.project_id",
    "google_api_key": "api_key[].current_key",
}
_FIREBASE_OPTIONAL = {
    "google_crash_reporting_api_key": "api_key[].current_key",
    "google_storage_bucket": "project_info.storage_bucket",
    "firebase_database_url": "project_info.firebase_url",
    "default_web_client_id": "oauth_client[client_type=3].client_id",
}

# Type descriptors as d8 stores them; used to prove the messaging classes that
# the config belongs to really are in the dex after d8 ran.
_FCM_DEX_TYPES = (
    b"Lcom/google/firebase/messaging/FirebaseMessaging;",
    b"Lcom/google/firebase/messaging/FirebaseMessagingService;",
)


def _rel(path):
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except (ValueError, OSError):
        return str(path)


def manifest_app_id():
    """The applicationId for this build: the app manifest's package attribute."""
    path = APP / "AndroidManifest.xml"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        die(f"cannot read {_rel(path)}: {exc}")
    match = re.search(r'package\s*=\s*"([^"]*)"', text)
    if not match or not match.group(1).strip():
        die(f"{_rel(path)} has no package attribute, so the applicationId is unknown")
    return match.group(1).strip()


def find_google_services(explicit=None):
    """(path, how) for the google-services.json to use, or (None, why not)."""
    candidates = []
    if explicit:
        candidates.append((Path(explicit), "--google-services"))
    env = os.environ.get(GOOGLE_SERVICES_ENV, "").strip()
    if env:
        candidates.append((Path(env), f"${GOOGLE_SERVICES_ENV}"))
    candidates += [(path, _rel(path)) for path in GOOGLE_SERVICES_FILES]

    for path, how in candidates:
        if path.is_file():
            return path, how
        if not how.startswith(("--", "$")):
            continue                    # a searched default: fine if absent
        # An explicit pointer is a claim; honour it or fail loudly.
        die(f"{how} points at {path}, which does not exist")

    looked = ", ".join(_rel(p) for p in GOOGLE_SERVICES_FILES)
    return None, f"${GOOGLE_SERVICES_ENV} is unset and none of {looked} exists"


def load_google_services(path):
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except OSError as exc:
        die(f"cannot read {path}: {exc}")
    try:
        doc = json.loads(text)
    except ValueError as exc:
        die(f"{_rel(path)} is not valid JSON: {exc}")
    if not isinstance(doc, dict):
        die(f"{_rel(path)} is not a google-services.json object")
    return doc


def _as_list(value):
    """google-services.json flips between object and array across formats."""
    if isinstance(value, dict):
        return [value]
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def select_google_client(doc, app_id, path):
    """The client entry whose android package_name == the manifest package."""
    clients = _as_list(doc.get("client"))
    if not clients:
        die(f'{_rel(path)} has no "client" entries')

    by_package = {}
    for client in clients:
        android = (client.get("client_info") or {}).get("android_client_info") or {}
        package = (android.get("package_name") or "").strip()
        if package:
            by_package.setdefault(package, client)

    client = by_package.get(app_id)
    if client is None:
        known = ", ".join(sorted(by_package)) or "none"
        die(f'{_rel(path)} has no client for package "{app_id}" (it declares: {known}).'
            " The applicationId comes from app/AndroidManifest.xml: register that exact"
            " package in the Firebase console and download the file again.")
    return client


def firebase_resource_values(doc, client, path):
    """Ordered {android string name: value} for the generated values.xml."""
    project = doc.get("project_info")
    if not isinstance(project, dict):
        die(f'{_rel(path)} has no "project_info" object')
    info = client.get("client_info") or {}

    current_key = None
    for entry in _as_list(client.get("api_key")):
        current_key = (entry.get("current_key") or "").strip()
        if current_key:
            break                                     # current_key, not legacy

    web_client_id = None
    for entry in _as_list(client.get("oauth_client")):
        if str(entry.get("client_type")) == "3" and entry.get("client_id"):
            web_client_id = str(entry["client_id"]).strip()
            break

    values = {
        "google_app_id": info.get("mobilesdk_app_id"),
        "gcm_defaultSenderId": project.get("project_number"),
        "project_id": project.get("project_id"),
        "google_api_key": current_key,
        # Firebase reads the same key again for Crashlytics-style reporting.
        "google_crash_reporting_api_key": current_key,
        "google_storage_bucket": project.get("storage_bucket"),
        "firebase_database_url": project.get("firebase_url"),
        "default_web_client_id": web_client_id,
    }
    values = {name: str(value).strip() for name, value in values.items()
              if value is not None and str(value).strip()}

    missing = [f"{_FIREBASE_REQUIRED[name]} ({name})"
               for name in _FIREBASE_REQUIRED if name not in values]
    if missing:
        die(f'{_rel(path)}: the client for this package is missing '
            + ", ".join(missing)
            + ". An APK carrying half a Firebase config starts FirebaseApp and"
              " then fails every token request, so the build stops here.")
    dropped = [name for name in _FIREBASE_OPTIONAL if name not in values]
    if dropped:
        log(f"firebase   not set in google-services.json (optional): {', '.join(dropped)}")
    return values


def _android_string(value):
    """Escape a value for aapt2's string-resource grammar.

    aapt2 rejects unescaped apostrophes ("unescaped apostrophe") and would strip
    quotes; a leading @ or ? would be read as a resource reference. ET has
    already done the XML-level escaping by the time this runs.
    """
    escaped = value.replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"')
    if escaped[:1] in ("@", "?"):
        escaped = "\\" + escaped
    return escaped


def write_firebase_resources(values, res_dir, source, app_id):
    """Write <res_dir>/values/values.xml; returns the res/ dir to aapt2-compile."""
    values_dir = Path(res_dir) / "values"
    values_dir.mkdir(parents=True, exist_ok=True)
    root = ET.Element("resources")
    for name, value in values.items():
        element = ET.SubElement(root, "string", {"name": name})
        element.text = _android_string(value)
    path = values_dir / "values.xml"
    path.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- GENERATED by tools/build_apk.py from google-services.json.\n"
        f"     source: {source}\n"
        f"     client: {app_id}\n"
        "     FirebaseOptions.fromResource() looks these names up by string, so\n"
        "     they have to reach resources.arsc. Do not hand-edit or copy this\n"
        "     into app/res/: edit the google-services.json in the Firebase console\n"
        "     and rebuild. -->\n"
        + ET.tostring(root, encoding="unicode") + "\n",
        encoding="utf-8",
    )
    return Path(res_dir)


def verify_fcm_dex(dex_files):
    """Prove firebase-messaging really was dexed into the APK's dex set.

    The full Firebase AAR closure is passed to d8, but a closure that silently
    lost firebase-messaging (or a d8 run that only took our classes) would still
    produce a valid apk -- one where js/push.js reports firebase-not-in-build at
    runtime. Searching the dex bytes for the class descriptors is cheap and
    fails the build instead of the phone.
    """
    missing = []
    for type_name in _FCM_DEX_TYPES:
        if not any(type_name in dex.read_bytes() for dex in dex_files):
            missing.append(type_name.decode("utf-8").strip("L;").replace("/", "."))
    if missing:
        die("Firebase Messaging is missing from the built dex: " + ", ".join(missing)
            + " (check .deps/firebase/closure.json and the d8 input list)")
    log(f"dex        verified {len(_FCM_DEX_TYPES)} firebase-messaging class(es) in "
        + ", ".join(dex.name for dex in dex_files))


def _parse_app_r(path):
    """Read the aapt2-generated app R.java into {class: [name=hex, ...]}.

    aapt2 link writes one class per resource type (string, layout, ...), each
    entry "public static final int <name>=0x...;". The merged table holds a
    single ID per resource name -- library resources included when their res/
    was linked with -R -- which is what makes mirroring this file into library
    namespaces correct for this build model.
    """
    classes, current = {}, None
    class_re = re.compile(r"public static final class (\w+)")
    entry_re = re.compile(r"public static final int (\w+)=0x[0-9a-fA-F]+;")
    for line in path.read_text(encoding="utf-8").splitlines():
        cm, em = class_re.search(line), entry_re.search(line)
        if cm:
            current = classes.setdefault(cm.group(1), [])
        elif em and current is not None:
            current.append(em.group(0))
    return {c: e for c, e in classes.items() if e}


def generate_library_r_sources(app_r_java, lib_manifests, gen):
    """Write R.java for every dependency package whose code dereferences R.

    `aapt2 link --java` only generates the R of the manifest package, but
    library bytecode compiled against its own AAR references
    L<lib-package>/R$string etc. (e.g. play-services-basement's
    StringResourceValueReader reads
    com.google.android.gms.common.R$string.common_google_play_services_unknown_issue
    during FirebaseInitProvider startup). A dex missing those classes dies with
    NoClassDefFoundError before any Activity runs -- the "blank dark screen
    then close" a first launch after the Firebase merge produced.

    The merged resource table is shared, so every generated R carries the same
    name->ID mapping as the app package: Resources.getIdentifier(), which is
    how this bytecode actually reads values, resolves names inside one table.
    """
    app_r = _parse_app_r(app_r_java)
    if not app_r:
        die(f"could not parse {_rel(app_r_java)}; cannot generate library R classes")

    packages = []
    for _coord, path in lib_manifests:
        try:
            match = re.search(r'package="([^"]*)"', path.read_text(encoding="utf-8"))
        except OSError as err:
            die(f"cannot read AAR manifest {_rel(path)}: {err}")
        if match and match.group(1) not in packages:
            packages.append(match.group(1))

    written = []
    for package in packages:
        dir_path = gen.joinpath(*package.split("."))
        dir_path.mkdir(parents=True, exist_ok=True)
        r_java = dir_path / "R.java"
        body = [
            "/* Generated by tools/build_apk.py -- mirrored library R.",
            f"   Package {package} dereferences its own R classes; the merged",
            "   resource table is shared, so every entry carries the same ID",
            "   as the app-package R. */",
            f"package {package};",
            "public final class R {",
        ]
        for cls_name, entries in app_r.items():
            body.append(f"    public static final class {cls_name} {{")
            body.extend(e + ";" for e in entries)
            body.append("    }")
        body.append("}")
        r_java.write_text("\n".join(body) + "\n", encoding="utf-8")
        written.append(r_java)
    return written


def verify_library_r_dex(dex_files, packages):
    """Prove each generated library R reached the dex set.

    A stale build that skipped generation survives to dex but crashes on the
    phone, so this is checked the same way verify_fcm_dex checks messaging:
    the class descriptors must exist in the dex bytes.
    """
    missing = []
    for package in packages:
        descriptor = f"L{package.replace('.', '/')}/R".encode("ascii")
        if not any(descriptor in dex.read_bytes() for dex in dex_files):
            missing.append(package)
    if missing:
        die("library R class(es) missing from the built dex: " + ", ".join(missing))
    log(f"dex        verified {len(packages)} library R package(s) in dex")


def verify_firebase_resources(aapt2, apk, expected):
    """Prove the generated config strings reached resources.arsc in the APK.

    The dump is the only end-to-end proof; a config that exists only in
    build/firebase-res/ would surface at runtime as "Default FirebaseApp is not
    initialized in this process", so this is a hard check (skipped only if aapt2
    cannot dump at all).
    """
    # aapt2 dumps localized values in every codepage; capture bytes and decode
    # defensively -- text=True would race cp1252 on arbitrary-locale strings.
    proc = subprocess.run([str(aapt2), "dump", "resources", str(apk)],
                          capture_output=True)
    dump = (proc.stdout or b"").decode("utf-8", "replace")
    if proc.returncode != 0 or not dump.strip():
        log("verify     could not dump resources; skipping Firebase config check")
        return
    absent = sorted(name for name in expected if f"string/{name}" not in dump)
    if absent:
        die("Firebase config resource(s) missing from the apk: " + ", ".join(absent)
            + " (the generated google-services.json resources were not linked)")
    wrong = sorted(name for name, value in expected.items() if value not in dump)
    if wrong:
        die("Firebase config resource(s) carry an unexpected value in the apk: "
            + ", ".join(wrong) + " (a stale overlay won the link)")
    log(f"verify     firebase: {len(expected)} config string(s) in resources.arsc")


# --- AAR manifest merger ---------------------------------------------------
# aapt2 links exactly one manifest and does not read the AARs, so the AAR
# manifests have to be merged here or every Firebase component stays invisible
# to the platform: FirebaseInitProvider (the auto-init provider),
# ComponentDiscoveryService, FirebaseInstanceIdReceiver and the
# "com.google.firebase.components:*" <meta-data> that name the registrars.
# The merge below follows the rules that matter for that (AGP's full merger is
# far larger): higher priority always wins, so the app manifest is the base and
# library elements only fill gaps. Library <application> attributes (androidx.core
# ships android:appComponentFactory) are filled in the same way.

ANDROID_NS = "http://schemas.android.com/apk/res/android"
TOOLS_NS = "http://schemas.android.com/tools"

# Elements keyed by android:name. Two AARs declaring the same service merge into
# one element with the union of their <meta-data> -- firebase-common and
# firebase-messaging both declare ComponentDiscoveryService, and dumping one of
# them (instead of unioning) silently breaks component discovery.
_NAMED_COMPONENTS = {"activity", "activity-alias", "service", "receiver", "provider"}
_NAMED_TAGS = _NAMED_COMPONENTS | {
    "meta-data", "uses-library", "uses-native-library", "property", "uses-package",
    # manifest-level elements that libraries also declare and that must not be
    # duplicated, e.g. com.google.android.c2dm.permission.RECEIVE
    "uses-permission", "uses-permission-sdk-23", "permission", "permission-group",
    "permission-tree", "uses-feature",
}

_XMLNS_RE = re.compile(r'xmlns:([A-Za-z_][\w.\-]*)\s*=\s*"([^"]*)"')


def _android(el, name):
    return el.get(f"{{{ANDROID_NS}}}{name}")


def _canon(el):
    """Structural identity, for "is this exact element already there" checks."""
    return (_local(el.tag),
            tuple(sorted(el.attrib.items())),
            tuple(_canon(c) for c in list(el)))


def _register_namespaces(texts):
    """Teach ElementTree the prefixes the sources use.

    Without register_namespace, serialisation invents ns0:/ns1: prefixes, and a
    manifest that redefines the android prefix is rejected by the platform.
    """
    chosen = {}
    for text in texts:
        for prefix, uri in _XMLNS_RE.findall(text):
            if prefix != "xml":
                chosen.setdefault(uri, prefix)
    for uri, prefix in chosen.items():
        ET.register_namespace(prefix, uri)


def _attr_name(attr):
    """'{http://...android}exported' -> 'android:exported', for log lines."""
    if attr.startswith("{%s}" % ANDROID_NS):
        return "android:" + attr.rsplit("}", 1)[-1]
    return attr.rsplit("}", 1)[-1]


def _prepare(el, app_id, library_package=""):
    """Strip tools:, expand ${applicationId}, qualify relative class names."""
    for name in [n for n in el.attrib if n.startswith("{%s}" % TOOLS_NS)]:
        del el.attrib[name]
    for name, value in list(el.attrib.items()):
        el.set(name, value.replace("${applicationId}", app_id)
                        .replace("${packageName}", app_id))
    if library_package and _local(el.tag) in _NAMED_COMPONENTS:
        name = _android(el, "name")
        # Only components are class names: <meta-data> names are arbitrary
        # strings ("backend:cct", "com.google.android.gms.version") and must be
        # left exactly as published.
        if name and ":" not in name:
            if name.startswith("."):
                # AGP resolves ".Service" against the AAR package, not the app's.
                el.set(f"{{{ANDROID_NS}}}name", library_package + name)
            elif "." not in name:
                el.set(f"{{{ANDROID_NS}}}name", f"{library_package}.{name}")
    for child in list(el):
        if isinstance(child.tag, str) and child.tag.startswith("{%s}" % TOOLS_NS):
            el.remove(child)            # <tools:node> style hints have no place here
            continue
        _prepare(child, app_id, library_package)
    return el


def _merge_attrs(dst, src):
    """Library attributes only fill gaps: an app attribute is never overridden."""
    for name, value in src.attrib.items():
        if name not in dst.attrib:
            dst.set(name, value)


def _merge_element(dst, src):
    _merge_attrs(dst, src)
    for child in list(src):
        if _local(child.tag) == "intent-filter":
            if not any(_local(e.tag) == "intent-filter" and _canon(e) == _canon(child)
                       for e in list(dst)):
                dst.append(copy.deepcopy(child))
            continue
        _upsert(dst, child)


def _upsert(parent, element):
    """Insert `element`, merging it with the same-key sibling when there is one."""
    tag = _local(element.tag)
    key = _android(element, "name") if tag in _NAMED_TAGS else None
    for existing in list(parent):
        if _local(existing.tag) != tag:
            continue
        if key is not None:
            if _android(existing, "name") == key:
                _merge_element(existing, element)
                return existing
        elif _canon(existing) == _canon(element):
            return existing
    parent.append(copy.deepcopy(element))
    return parent[-1]


def _min_sdk(el):
    try:
        return int(str(_android(el, "minSdkVersion")).strip())
    except (TypeError, ValueError):
        return None


def _merge_uses_sdk(root, lib_el):
    """One <uses-sdk> in the output, minSdk raised to the highest contributor."""
    current = root.find("uses-sdk")
    if current is None:
        current = ET.Element("uses-sdk")
        root.insert(0, current)         # AGP emits it first
    lib_min, current_min = _min_sdk(lib_el), _min_sdk(current)
    if lib_min is not None and (current_min is None or lib_min > current_min):
        current.set(f"{{{ANDROID_NS}}}minSdkVersion", str(lib_min))
    # targetSdk is the app's decision: a library must never raise it.


def _permission_names(root):
    return {_android(el, "name") for el in root
            if _local(el.tag) in ("uses-permission", "uses-permission-sdk-23")
            and _android(el, "name")}


def _component_names(app_el):
    return {(_local(el.tag), _android(el, "name") or "") for el in app_el}


def merge_library_manifests(app_manifest, libraries, app_id):
    """Merge AAR manifests into the app manifest; returns (text, report).

    `libraries` is [(coord, path, text)]. The app manifest is the base, so its
    components, permissions and attributes always win; library contributions are
    appended or filled in.
    """
    _register_namespaces([app_manifest] + [text for _c, _p, text in libraries])
    root = ET.fromstring(app_manifest)
    app_el = root.find("application")
    if app_el is None:
        die("app/AndroidManifest.xml has no <application> element")
    app_id = app_id or root.get("package") or ""
    if not app_id:
        die("app/AndroidManifest.xml has no package attribute")
    before_perms, before_components = _permission_names(root), _component_names(app_el)

    for coord, path, text in libraries:
        try:
            lib = ET.fromstring(text)
        except ET.ParseError as exc:
            die(f"cannot parse vendored manifest {path}: {exc}")
        package = (lib.get("package") or "").strip()
        _prepare(lib, app_id, package)
        for child in list(lib):
            tag = _local(child.tag)
            if tag in ("application", "manifest"):
                continue
            if tag == "uses-sdk":
                _merge_uses_sdk(root, child)
                continue
            if tag == "queries":
                bucket = root.find("queries")
                if bucket is None:
                    bucket = ET.SubElement(root, "queries")
                for entry in list(child):
                    _upsert(bucket, entry)
                continue
            _upsert(root, child)
        lib_application = lib.find("application")
        if lib_application is not None:
            # <application> attributes, not just its children: androidx.core
            # publishes android:appComponentFactory here and AGP merges it. The
            # app's own attributes win, _merge_attrs only fills gaps.
            added = [n for n in lib_application.attrib if n not in app_el.attrib]
            _merge_attrs(app_el, lib_application)
            if added:
                log(f"manifest   <application> +{len(added)} attribute(s) from "
                    f"{coord}: " + ", ".join(sorted(_attr_name(n) for n in added)))
            for child in list(lib_application):
                _upsert(app_el, child)

    merged_components = sorted({name for _tag, name in _component_names(app_el)} - {""})
    report = {
        "permissions": sorted(_permission_names(root) - before_perms),
        "components": merged_components,
        "added_components": (len(_component_names(app_el)) - len(before_components)),
        "meta_data": sum(1 for el in app_el.iter() if _local(el.tag) == "meta-data"),
        "providers": sum(1 for el in app_el if _local(el.tag) == "provider"),
        "min_sdk": _min_sdk(root.find("uses-sdk")) if root.find("uses-sdk") is not None else None,
        # androidx.core ships this; dropping it changes runtime behaviour silently.
        "app_component_factory": _android(app_el, "appComponentFactory"),
    }
    remaining = set(re.findall(r"\$\{[A-Za-z0-9_.]+\}", ET.tostring(root, encoding="unicode")))
    if remaining:
        die("unexpanded manifest placeholder(s): " + ", ".join(sorted(remaining))
            + " -- the merger only knows ${applicationId}/${packageName}")
    try:
        ET.indent(root, space="    ")
    except AttributeError:              # Python < 3.9: keep source whitespace
        pass
    header = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- GENERATED by tools/build_apk.py: app/AndroidManifest.xml merged with the\n"
        f"     AAR manifests vendored under .deps/firebase/manifests ({len(libraries)} of them).\n"
        "     App entries win; library components are merged by android:name, <meta-data>\n"
        "     unioned, <application> attributes filled in, tools: attributes dropped,\n"
        "     ${applicationId} expanded.\n"
        "     Edit app/AndroidManifest.xml, never this file. -->\n"
    )
    return header + ET.tostring(root, encoding="unicode") + "\n", report


def verify_merged_manifest(aapt2, apk, report):
    """Confirm the linked manifest really carries the merged Firebase entries.

    The dump is the only end-to-end proof that the merge reached the binary APK;
    a component absent here means Firebase silently fails to initialise at
    runtime, so this is a hard check (it is skipped only if aapt2 cannot dump).
    """
    proc = subprocess.run([str(aapt2), "dump", "xmltree", "--file",
                           "AndroidManifest.xml", str(apk)],
                          capture_output=True)
    dump = (proc.stdout or b"").decode("utf-8", "replace")
    if proc.returncode != 0 or not dump.strip():
        log("verify     could not dump the linked manifest; skipping component check")
        return
    required = [
        "com.google.firebase.provider.FirebaseInitProvider",
        "com.google.firebase.components.ComponentDiscoveryService",
        "com.google.firebase.messaging.FirebaseMessagingRegistrar",
        "com.google.firebase.iid.FirebaseInstanceIdReceiver",
        "com.google.android.c2dm.permission.RECEIVE",
    ]
    absent = [name for name in required if name not in dump]
    factory = report.get("app_component_factory")
    if factory:
        # A merged <application> attribute has to survive the link too.
        absent += [name for name in ("appComponentFactory", factory.split(".")[-1])
                   if name not in dump]
    if absent:
        die("merged manifest is missing " + ", ".join(absent)
            + " (AAR manifest merge did not reach the APK)")
    log(f"verify     manifest: {len(report['components'])} component(s), "
        f"{report['providers']} provider(s), {report['meta_data']} <meta-data>, "
        f"minSdk {report['min_sdk']}")


# Constant-pool entry sizes (bytes after the 1-byte tag). Long/Double occupy two
# pool slots, which the parser below accounts for separately.
_CP_SIZE = {1: None, 3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4,
            12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2}


def strip_method_parameters(class_files):
    """Delete the MethodParameters attribute from every class file.

    JDK 21+ emits MethodParameters by default, including entries whose name is
    the empty constant (#0) for synthetic parameters such as the outer-instance
    argument of an inner class. R8 8.2.2 (the dexer shipped in build-tools 34)
    dereferences that null name and dies with
        NullPointerException: Cannot invoke "String.length()" because
        "<parameter1>" is null
    while compiling such a class. The attribute is pure debug metadata -- dex
    ignores it, reflection never sees it -- so dropping it before d8 is a lossless
    fix that keeps the whole toolchain on a stock JDK.

    Only our own classes go through this: dependency jars are handed to d8
    untouched (their publishers do not emit the broken attribute).
    """
    dropped = 0
    for path in class_files:
        path = Path(path)
        data = path.read_bytes()
        if data[:4] != b"\xca\xfe\xba\xbe":
            die(f"{path} is not a class file")

        def u2(off):
            return int.from_bytes(data[off:off + 2], "big")

        def u4(off):
            return int.from_bytes(data[off:off + 4], "big")

        cp_count = u2(8)
        utf8, off, idx = {}, 10, 1
        while idx < cp_count:
            tag = data[off]
            if tag == 1:
                length = u2(off + 1)
                utf8[idx] = data[off + 3:off + 3 + length]
                off += 3 + length
            else:
                size = _CP_SIZE.get(tag)
                if size is None:
                    die(f"{path}: unknown constant-pool tag {tag}")
                off += 1 + size
                if tag in (5, 6):
                    idx += 1
            idx += 1
        cp_end = off

        def copy_members(pos, count):
            """Copy `count` field_info/method_info blocks, returning (bytes, end)."""
            start, p = pos, pos
            for _ in range(count):
                attrs = u2(p + 6)
                p += 8
                for _ in range(attrs):
                    p += 6 + u4(p + 2)
            return data[start:p], p

        out = bytearray(data[:cp_end])
        out += data[cp_end:cp_end + 6]
        pos = cp_end + 6
        ifc = u2(pos)
        out += data[pos:pos + 2 + 2 * ifc]
        pos += 2 + 2 * ifc
        fcount = u2(pos)
        fields, pos = copy_members(pos + 2, fcount)
        out += fcount.to_bytes(2, "big") + fields
        mcount = u2(pos)
        pos += 2
        out += mcount.to_bytes(2, "big")
        for _ in range(mcount):
            attrs, q = u2(pos + 6), pos + 8
            kept = bytearray()
            removed = 0
            for _ in range(attrs):
                length = u4(q + 2)
                if utf8.get(u2(q)) == b"MethodParameters":
                    removed += 1
                else:
                    kept += data[q:q + 6 + length]
                q += 6 + length
            dropped += removed
            out += data[pos:pos + 6] + (attrs - removed).to_bytes(2, "big") + kept
            pos = q
        out += data[pos:]                                     # class attributes

        if len(out) != len(data):
            tmp = path.with_suffix(".class.tmp")
            tmp.write_bytes(out)
            os.replace(tmp, path)
    return dropped


def dex_index(path):
    """classes.dex -> 1, classes2.dex -> 2 (d8 may emit several on minSdk 24)."""
    m = re.search(r"classes(\d*)\.dex$", Path(path).name)
    return int(m.group(1) or 1) if m else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sdk")
    ap.add_argument("--out", default="dist")
    ap.add_argument("--no-deps", action="store_true",
                    help="skip .deps/firebase (debug builds of the shell only)")
    ap.add_argument("--google-services", metavar="PATH",
                    help="google-services.json to use (overrides "
                         f"${GOOGLE_SERVICES_ENV}, app/google-services.json and "
                         "<repo>/google-services.json)")
    ap.add_argument("--require-fcm", action="store_true",
                    help="fail instead of warning when no google-services.json is "
                         "available (the APK would ship Firebase without config)")
    args = ap.parse_args()

    sdk = find_sdk(args.sdk)
    build_tools = newest(sdk / "build-tools", lambda d: True)
    platform = newest(sdk / "platforms", lambda d: True)
    if not build_tools or not platform:
        die("SDK is missing build-tools or platforms")
    android_jar = platform / "android.jar"
    log(f"SDK        {sdk}")
    log(f"build-tools {build_tools.name}   platform {platform.name}")

    aapt2 = tool(build_tools, "aapt2")
    d8 = tool(build_tools, "d8")
    zipalign = tool(build_tools, "zipalign")
    apksigner = tool(build_tools, "apksigner")
    javac = shutil.which("javac") or die("javac not on PATH (need JDK 11+)")
    keytool = shutil.which("keytool") or die("keytool not on PATH (need JDK)")

    if BUILD.exists():
        shutil.rmtree(BUILD)
    gen, classes, dex_out = BUILD / "gen", BUILD / "classes", BUILD / "dex"
    for d in (BUILD, gen, classes, dex_out):
        d.mkdir(parents=True, exist_ok=True)

    # 1. dependency closure ------------------------------------------------
    # Everything the build needs from the vendored AARs comes out of
    # closure.json: the jars (javac classpath + d8 input) and, per AAR, its
    # res/ dir and manifest. This is what Gradle's per-variant dependency
    # resolution + AAR transform would hand to the compiler, aapt2 and the
    # manifest merger.
    artifacts = None if args.no_deps else _closure_artifacts()
    if args.no_deps:
        deps, res_dirs, lib_manifests = [], [], []
        log("deps       --no-deps: no dependency jars, res/ overlays or AAR manifests")
    else:
        if artifacts is None:
            die(f"Firebase dependency tree not found at {DEPS}; run "
                "'python tools/fetch_firebase_deps.py', or pass --no-deps")
        deps = dependency_jars(BUILD / "deps")
        res_dirs, lib_manifests = dependency_assets()
        log(f"deps       {len(artifacts)} artifact(s): {len(deps)} jar(s), "
            f"{len(res_dirs)} res/ dir(s), {len(lib_manifests)} manifest(s)")

    # 1b. Firebase runtime configuration (google-services.json) -----------
    # The only build-time thing the google-services plugin does, done here:
    # google-services.json -> res/values/values.xml -> resources.arsc. The
    # applicationId comes from the manifest, because it is the key that picks
    # the right client out of a multi-package file.
    firebase_values, firebase_res, firebase_source = {}, None, None
    app_id = manifest_app_id()
    if args.no_deps:
        log("firebase   --no-deps: no Firebase classes are dexed, so "
            "google-services.json is not consumed")
    else:
        gs_path, gs_how = find_google_services(args.google_services)
        if gs_path is None:
            unconfigured = (
                f"no google-services.json ({gs_how}). The APK ships the Firebase "
                "classes but no project config, so FirebaseApp cannot initialise "
                "and no FCM token can be minted; js/push.js will keep reporting "
                "firebase-not-in-build")
            if args.require_fcm:
                die(unconfigured + " (--require-fcm)")
            log("firebase   " + unconfigured)
        else:
            gs_doc = load_google_services(gs_path)
            gs_client = select_google_client(gs_doc, app_id, gs_path)
            firebase_values = firebase_resource_values(gs_doc, gs_client, gs_path)
            digest = hashlib.sha256(Path(gs_path).read_bytes()).hexdigest()[:12]
            firebase_source = f"{gs_how} (sha256 {digest})"
            firebase_res = write_firebase_resources(
                firebase_values, BUILD / "firebase-res", firebase_source, app_id)
            log(f"firebase   {firebase_source}")
            log(f"firebase   client {app_id}: {len(firebase_values)} value(s), "
                f"app_id {firebase_values['google_app_id']}, "
                f"project {firebase_values['project_id']}, "
                f"sender {firebase_values['gcm_defaultSenderId']}")
            log(f"firebase   generated {_rel(firebase_res / 'values' / 'values.xml')}")

    # 2. resources ---------------------------------------------------------
    # aapt2 compiles one .zip per res/ dir; the order in which they are passed
    # to `aapt2 link` decides which duplicate definition wins, so the app is
    # last (app res/ overlays every library resource, as in AGP).
    dep_archives = []
    overlays = list(res_dirs)
    if firebase_res is not None:
        # One more overlay, after the AAR res/ dirs and before the app: the
        # generated values are Firebase-owned, but if app/res ever declares one
        # of these names the app keeps precedence, as with the real plugin.
        overlays.append(("google-services.json", firebase_res))
    if overlays:
        report_overlay_precedence(overlays, APP / "res")
    if res_dirs:
        dep_archives = compile_dependency_resources(aapt2, res_dirs, BUILD / "deps-res")
    if firebase_res is not None:
        dep_archives += compile_dependency_resources(
            aapt2, [("google-services-config", firebase_res)], BUILD / "gen-res")
    res_zip = BUILD / "resources.zip"
    run([aapt2, "compile", "--dir", APP / "res", "-o", res_zip])

    # 3. manifest ----------------------------------------------------------
    # aapt2 ignores --version-code/--version-name when the manifest already
    # declares them, so stage a copy with both attributes pinned to VERSION_*.
    # The manifest stays the readable spec; the constants stay authoritative.
    manifest = BUILD / "AndroidManifest.xml"
    text = (APP / "AndroidManifest.xml").read_text(encoding="utf-8")
    text, n_code = re.subn(
        r'android:versionCode="[^"]*"',
        f'android:versionCode="{VERSION_CODE}"',
        text,
    )
    text, n_name = re.subn(
        r'android:versionName="[^"]*"',
        f'android:versionName="{VERSION_NAME}"',
        text,
    )
    if not (n_code and n_name):
        die("AndroidManifest.xml is missing android:versionCode/versionName")

    # app_id was resolved from this same manifest in step 1b (the Firebase client
    # lookup keys off it), and the version rewrite above does not touch it.
    if lib_manifests:
        lib_texts = [(coord, path, path.read_text(encoding="utf-8"))
                     for coord, path in lib_manifests]
        text, report = merge_library_manifests(text, lib_texts, app_id)
        added = report["added_components"]
        log(f"manifest   merged {len(lib_texts)} AAR manifest(s) into the app manifest "
            f"(+{added} <application> entr{'y' if added == 1 else 'ies'}, "
            f"+{len(report['permissions'])} permission(s))")
        if report["added_components"] <= 0:
            die("AAR manifests contributed no <application> entries; the vendored "
                "manifests look empty or unparseable")
        if report["permissions"]:
            log("manifest   +" + ", ".join(report["permissions"][:6]))
    manifest.write_text(text, encoding="utf-8")

    # 4. link: one manifest + dep archives first, app archive last --------
    unsig = BUILD / "base-unsigned.apk"
    link_cmd = [aapt2, "link", "-o", unsig, "-I", android_jar, "--manifest", manifest]
    for _coord, archive in dep_archives:
        link_cmd += ["-R", archive]
    link_cmd += [
        "-R", res_zip,
        "--java", gen,
        "-A", APP / "assets",
        "--min-sdk-version", str(MIN_SDK),
        "--target-sdk-version", str(TARGET_SDK),
        "--auto-add-overlay",
    ]
    run(link_cmd)
    if lib_manifests:
        verify_merged_manifest(aapt2, unsig, report)
    if firebase_values:
        # resources.arsc is written by `aapt2 link`, so this is the first point
        # at which the generated config can be checked inside the real apk.
        verify_firebase_resources(aapt2, unsig, firebase_values)
        log(f"verify     Firebase config strings are in {_rel(unsig)}")

    # 4c. library R classes -------------------------------------------------
    # The dex must also contain R classes for each library package: their
    # bytecode references L<lib>/R$string with its own namespace, and aapt2
    # only emitted the app package's R (see generate_library_r_sources).
    lib_r_sources = generate_library_r_sources(
        gen / "com" / "familyshield" / "app" / "R.java", lib_manifests, gen)
    lib_r_packages = []
    for source in lib_r_sources:
        lib_r_packages.append(".".join(source.parent.relative_to(gen).parts))
    if lib_r_packages:
        log(f"gen        wrote {len(lib_r_sources)} library R.java: "
            + ", ".join(lib_r_packages[:4]) + (" ..." if len(lib_r_packages) > 4 else ""))    # 4b. dependency jars --------------------------------------------------
    # javac compiles the app against these jars and d8 dexes them into the apk,
    # so Firebase Messaging ends up in the same classes.dex set as our code --
    # the job Gradle's AAR/dex merging would do. Resources and manifests are
    # already in (steps 2-4), so the R classes generated into BUILD/gen cover
    # both app and library resources.
    classpath = [str(android_jar)] + [str(j) for j in deps]

    # 5. java --------------------------------------------------------------
    java_sources = sorted(str(p) for p in (list((APP / "java").rglob("*.java"))
                                           + list(gen.rglob("*_R.java"))
                                           + list(gen.rglob("R.java"))
                                           + list(gen.rglob("Manifest.java"))))
    if not java_sources:
        die("no Java sources found")
    compile_cmd = [javac, "-encoding", "UTF-8", "-nowarn", "-d", classes,
                   f"--release", str(JAVA_RELEASE),
                   "-classpath", os.pathsep.join(classpath)] + java_sources
    log(f"javac: {len(java_sources)} source file(s), {len(classpath) - 1} classpath jar(s)")
    proc = subprocess.run([str(c) for c in compile_cmd], capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout, proc.stderr, file=sys.stderr)
        die("javac failed")
    if proc.stderr.strip():
        log(proc.stderr.strip())

    # 6. dex ---------------------------------------------------------------
    class_files = sorted(str(p) for p in classes.rglob("*.class"))
    dropped = strip_method_parameters(class_files)
    if dropped:
        log(f"stripped {dropped} MethodParameters attribute(s) (R8 8.2.2 null-name bug)")
    log(f"d8: {len(class_files)} class file(s) + {len(deps)} jar(s) -> {dex_out}")
    # One Firebase-classpath dex run can exceed the Windows 32767-character
    # command line once the AAR closure is fully expanded. d8 supports
    # @<argfile> (one argument per line, not re-split), so the long input list
    # goes into a file and the process invocation stays short.
    d8_args = [d8, "--release", "--min-api", str(MIN_SDK), "--lib", str(android_jar),
               "--output", str(dex_out)] + class_files + [str(j) for j in deps]
    argfile = BUILD / "d8-args.txt"
    argfile.parent.mkdir(parents=True, exist_ok=True)
    argfile.write_text("\n".join(str(a) for a in d8_args[1:]) + "\n", encoding="utf-8")
    proc = subprocess.run([str(d8_args[0]), "@" + str(argfile)],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout, proc.stderr, file=sys.stderr)
        die("d8 failed")
    # A dependency closure always carries optional integrations we do not ship
    # (play-services-analytics, Firestore, ...). d8 reports those as
    # "Missing class" warnings and still produces valid dex, so summarise
    # instead of letting 40 lines of warnings scroll past.
    missing = [ln.strip() for ln in (proc.stdout + proc.stderr).splitlines()
               if "Missing class" in ln]
    if missing:
        log(f"d8: {len(missing)} unresolved reference(s), e.g. {missing[0][:150]}")
    # minSdk 24 supports multidex natively, so a dependency-laden app can legally
    # produce classes2.dex/classes3.dex; all of them belong in the apk.
    dex_files = sorted(dex_out.glob("classes*.dex"), key=dex_index)
    if not dex_files or dex_files[0].name != "classes.dex":
        die("d8 produced no classes.dex")
    if len(dex_files) > 1:
        log(f"d8 produced {len(dex_files)} dex files: {', '.join(p.name for p in dex_files)}")
    if deps:
        verify_fcm_dex(dex_files)
        verify_library_r_dex(dex_files, lib_r_packages)

    # 7. package dex next to the resources --------------------------------
    with zipfile.ZipFile(unsig, "a", zipfile.ZIP_DEFLATED) as zf:
        for dex in dex_files:
            zf.write(dex, dex.name)
    with zipfile.ZipFile(unsig) as zf:
        names = sorted(zf.namelist())
    log(f"apk entries: {len(names)} (assets: {sum(1 for n in names if n.startswith('assets/'))})")
    for required in ("AndroidManifest.xml", "classes.dex", "resources.arsc",
                     "assets/www/index.html"):
        if required not in names:
            die(f"missing from apk: {required}")

    # 8. align + sign ------------------------------------------------------
    aligned = BUILD / "base-aligned.apk"
    run([zipalign, "-f", "-p", "4", unsig, aligned])

    # Keep the debug key outside build/ — that directory is wiped every run, and
    # a fresh key each build means the next APK cannot upgrade-install over this one.
    keystore = ROOT / "keystore" / "debug.keystore"
    keystore.parent.mkdir(parents=True, exist_ok=True)
    if not keystore.is_file():
        run([keytool, "-genkeypair", "-keystore", keystore, "-storepass", "android",
             "-keypass", "android", "-alias", "androiddebugkey", "-keyalg", "RSA",
             "-keysize", "2048", "-validity", "10000",
             "-dname", "CN=Android Debug,O=Android,C=US"])

    out_dir = ROOT / args.out
    out_dir.mkdir(exist_ok=True)
    signed = out_dir / f"FamilyShield-{VERSION_NAME}.apk"
    if signed.exists():
        signed.unlink()
    run([apksigner, "sign", "--ks", keystore, "--ks-pass", "pass:android",
         "--key-pass", "pass:android", "--ks-key-alias", "androiddebugkey",
         "--min-sdk-version", str(MIN_SDK), "--out", signed, aligned])
    run([apksigner, "verify", "--print-certs", "--verbose", signed])

    # 9. keep the verified artifact in build/ for inspection too ----------
    shutil.copy2(signed, BUILD / signed.name)
    size = signed.stat().st_size
    if firebase_values:
        log(f"firebase   configured from {firebase_source}")
    elif not args.no_deps:
        log("firebase   UNCONFIGURED: Firebase classes are present but "
            "FirebaseApp cannot initialise without google-services.json")
    log(f"OK  {signed}  ({size:,} bytes)")


if __name__ == "__main__":
    main()
