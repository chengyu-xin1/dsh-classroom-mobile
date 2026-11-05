#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""预下载 faster-whisper 模型（dsh-classroom-mobile 部署用）。

用法：
    python scripts/download_model.py [--model small] [--model-dir D:\dsh-classroom-mobile\data\models]

环境：
    HF_ENDPOINT     默认 https://hf-mirror.com（官方 huggingface.co 校园网不可达）
    HF_HUB_DISABLE_XET 默认 1

成功后打印模型快照的真实路径与目录大小，供部署记录。失败时 stderr 说明原因、退出码 1。
"""

import argparse
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

DEFAULT_MODEL_DIR = r"D:\dsh-classroom-mobile\data\models"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEV_MODEL_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "data", "models")


def dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def main() -> int:
    parser = argparse.ArgumentParser(description="下载 faster-whisper 模型到 model-dir")
    parser.add_argument("--model", default="small")
    parser.add_argument("--model-dir", default=None)
    args = parser.parse_args()

    model_dir = args.model_dir or os.environ.get("DSH_CLASSROOM_MODEL_DIR") or (
        DEFAULT_MODEL_DIR if os.path.isdir(DEFAULT_MODEL_DIR) else DEV_MODEL_DIR
    )
    model_dir = os.path.abspath(model_dir)
    os.makedirs(model_dir, exist_ok=True)

    print(f"[info] HF_ENDPOINT={os.environ.get('HF_ENDPOINT')}", file=sys.stderr)
    print(f"[info] 下载 {args.model} -> {model_dir}", file=sys.stderr)

    try:
        from faster_whisper.utils import download_model
    except Exception as exc:  # noqa: BLE001
        print(f"[error] 无法导入 faster_whisper: {exc}", file=sys.stderr)
        return 1

    try:
        snapshot = download_model(args.model, cache_dir=model_dir)
    except Exception as exc:  # noqa: BLE001
        print(f"[error] 下载失败: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("[hint] 若 hf-mirror 失败，可尝试 modelscope:  "
              "python -m pip install modelscope -i https://pypi.tuna.tsinghua.edu.cn/simple",
              file=sys.stderr)
        return 1

    snapshot = os.path.abspath(str(snapshot))
    print(f"[ok] 模型路径: {snapshot}", file=sys.stderr)
    print(f"[ok] 模型目录总大小: {dir_size(snapshot) / (1024 * 1024):.1f} MB", file=sys.stderr)
    # stdout 给出一行机器可读结果
    print(snapshot)
    return 0


if __name__ == "__main__":
    sys.exit(main())
