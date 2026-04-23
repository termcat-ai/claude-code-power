#!/usr/bin/env python3
"""
Auto-update the file manifest region of claude_code_power/claude_refs/ARCHITECTURE.md.

Scans all .ts/.tsx/.js/.jsx/.css sources under src/, plus root-level config files,
extracts the first JSDoc / block comment line as a short description, renders a
tree listing, and replaces the <!-- AUTO-GENERATED:START/END --> region.

Usage:
    python3 termcat_client_plugin/claude_code_power/scripts/update_architecture_manifest.py

Design:
    - Idempotent: re-runs produce identical output (except the timestamp).
    - Silent no-op when ARCHITECTURE.md is missing.
    - Path-filtered: when invoked via a PostToolUse hook the CLAUDE_TOOL_USE_INPUT
      env var is inspected; skips unless the touched file is under this plugin.
    - Only rewrites the file when the set of paths actually changed (descriptions
      alone don't trigger a rewrite).
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SCRIPT_DIR.parent  # termcat_client_plugin/claude_code_power/
SRC_ROOT = PLUGIN_ROOT / "src"
ARCHITECTURE_MD = PLUGIN_ROOT / "claude_refs" / "ARCHITECTURE.md"

# Trigger dir for hook path filtering — matches anywhere in the changed file path
TRIGGER_DIR = "termcat_client_plugin/claude_code_power"
TREE_ROOT_LABEL = "claude_code_power/"

# ── Exclusions ───────────────────────────────────────────────
EXCLUDE_DIRS = {
    "node_modules",
    "dist",
    ".git",
    "coverage",
    "__tests__",
    "temp",
}

INCLUDE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".css"}

ROOT_CONFIG_FILES = {
    "package.json",
    "tsconfig.json",
    "esbuild.config.mjs",
}

# ── Markers ──────────────────────────────────────────────────
START_MARKER = "<!-- AUTO-GENERATED:START -->"
END_MARKER = "<!-- AUTO-GENERATED:END -->"


def should_exclude(path: Path) -> bool:
    for part in path.parts:
        if part in EXCLUDE_DIRS:
            return True
    return False


def extract_jsdoc_first_line(filepath: Path) -> str:
    """Pull the first JSDoc/block/line comment description from the top 10 lines."""
    try:
        lines = filepath.read_text(encoding="utf-8", errors="replace").split("\n")[:10]
    except (OSError, UnicodeDecodeError):
        return ""

    for line in lines:
        stripped = line.strip()
        m = re.match(r'/\*\*\s*(.+?)\s*\*/', stripped)
        if m:
            return m.group(1).strip()
        if stripped.startswith("/**"):
            continue
        if stripped.startswith("*"):
            desc = stripped.lstrip("*").strip()
            if desc and not desc.startswith("@"):
                return desc
        if stripped.startswith("//"):
            desc = stripped.lstrip("/").strip()
            if desc:
                return desc
            continue
        if stripped and not stripped.startswith("'use") and not stripped.startswith('"use'):
            break

    return ""


def scan_src_files(src_root: Path) -> list[tuple[Path, str]]:
    results = []
    if not src_root.exists():
        return results
    for dirpath, dirnames, filenames in os.walk(src_root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS)
        dp = Path(dirpath)
        for fname in sorted(filenames):
            fpath = dp / fname
            if fpath.suffix not in INCLUDE_EXTENSIONS:
                continue
            rel = fpath.relative_to(PLUGIN_ROOT)
            if should_exclude(rel):
                continue
            desc = extract_jsdoc_first_line(fpath)
            results.append((rel, desc))
    return results


def scan_root_configs(plugin_root: Path) -> list[tuple[Path, str]]:
    results = []
    for fname in sorted(ROOT_CONFIG_FILES):
        fpath = plugin_root / fname
        if fpath.exists():
            results.append((Path(fname), ""))
    return results


def build_tree_text(files: list[tuple[Path, str]]) -> str:
    tree: dict = {}
    for rel, desc in files:
        parts = rel.parts
        node = tree
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = desc

    lines: list[str] = [TREE_ROOT_LABEL]

    def render(node: dict, prefix: str = ""):
        items = list(node.items())
        for i, (name, value) in enumerate(items):
            is_last = i == len(items) - 1
            connector = "└── " if is_last else "├── "
            extension = "    " if is_last else "│   "

            if isinstance(value, dict):
                lines.append(f"{prefix}{connector}{name}/")
                render(value, prefix + extension)
            else:
                desc_str = value
                if desc_str:
                    entry = f"{prefix}{connector}{name}"
                    padding = max(2, 48 - len(entry))
                    lines.append(f"{entry}{' ' * padding}# {desc_str}")
                else:
                    lines.append(f"{prefix}{connector}{name}")

    render(tree)
    return "\n".join(lines)


def strip_tree_descriptions(tree_text: str) -> str:
    out = []
    for line in tree_text.split("\n"):
        idx = line.find("  # ")
        if idx != -1:
            line = line[:idx]
        out.append(line.rstrip())
    return "\n".join(out)


def extract_existing_tree(content: str, start_idx: int, end_idx: int) -> str:
    region = content[start_idx + len(START_MARKER):end_idx]
    lines = region.strip().split("\n")
    tree_lines = []
    in_code_block = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            continue
        if stripped.startswith("<!--"):
            continue
        if in_code_block:
            tree_lines.append(line)
    return "\n".join(tree_lines).strip()


def update_architecture_md(tree_text: str) -> bool:
    if not ARCHITECTURE_MD.exists():
        return False

    content = ARCHITECTURE_MD.read_text(encoding="utf-8")

    start_idx = content.find(START_MARKER)
    end_idx = content.find(END_MARKER)

    if start_idx == -1 or end_idx == -1 or start_idx >= end_idx:
        print(f"WARNING: markers not found or invalid in {ARCHITECTURE_MD}", file=sys.stderr)
        return False

    existing_tree = extract_existing_tree(content, start_idx, end_idx)
    if strip_tree_descriptions(existing_tree) == strip_tree_descriptions(tree_text):
        return False

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    replacement = (
        f"{START_MARKER}\n"
        f"<!-- 自动生成，请勿手动编辑此区域 | Auto-generated, do not edit manually -->\n"
        f"<!-- 最后更新: {timestamp} -->\n"
        f"\n"
        f"```\n"
        f"{tree_text}\n"
        f"```\n"
        f"\n"
    )

    new_content = content[:start_idx] + replacement + content[end_idx:]
    ARCHITECTURE_MD.write_text(new_content, encoding="utf-8")
    return True


def is_triggered_by_relevant_file() -> bool:
    tool_input_raw = os.environ.get("CLAUDE_TOOL_USE_INPUT")
    if not tool_input_raw:
        return True

    try:
        tool_input = json.loads(tool_input_raw)
        file_path = tool_input.get("file_path", "")
        return TRIGGER_DIR in file_path
    except (json.JSONDecodeError, TypeError):
        return TRIGGER_DIR in tool_input_raw


def main():
    if not ARCHITECTURE_MD.exists():
        sys.exit(0)

    if not is_triggered_by_relevant_file():
        sys.exit(0)

    root_configs = scan_root_configs(PLUGIN_ROOT)
    src_files = scan_src_files(SRC_ROOT)
    all_files = root_configs + src_files

    tree_text = build_tree_text(all_files)

    success = update_architecture_md(tree_text)

    if success:
        print(f"Updated {ARCHITECTURE_MD} ({len(all_files)} files)")
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
