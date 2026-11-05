#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""faster-whisper 中文转写脚本（dsh-classroom-mobile 专用）

用法：
    python transcribe.py <音频路径> [--offset 秒] [--model-dir 模型缓存目录] [--model small]

输入要求：16kHz / 单声道 / 16bit PCM 的 .wav（Node 侧固定先用 ffmpeg 转成这个格式）。
输出（stdout 只输出这一个 JSON）：
    {"segments":[{"start":0.0,"end":3.2,"text":"..."}],"duration":12.3,...}
失败时把原因写到 stderr 并以非 0 退出码结束。绝不伪造文本。

为什么自己读 wav 再交给模型：
当前环境 faster-whisper 1.2.1 内部用 `av.open(..., metadata_errors="ignore")`，
而 PyAV 19 的 open() 不接受这个参数，直接传文件路径会报
`open() got an unexpected keyword argument 'metadata_errors'`。
传 numpy 数组则完全绕开 PyAV 解码，稳定且更快。

注意：官方 huggingface.co 在部分校园网不可达，这里默认走 hf-mirror.com；
可用环境变量 HF_ENDPOINT 覆盖。
"""
import argparse
import json
import os
import sys
import wave

# 必须在 import huggingface_hub / faster_whisper 之前设置
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

SAMPLE_RATE = 16000


def load_wav_16k_mono(path):
    """读取 16k 单声道 16bit wav，返回 (float32 numpy 数组, 时长秒)。"""
    try:
        import numpy as np
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("缺少 numpy：%s" % exc)
    try:
        with wave.open(path, "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            frames = wf.readframes(wf.getnframes())
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("无法读取 wav（Node 侧应先用 ffmpeg 转 16k 单声道）：%s" % exc)
    if channels != 1:
        raise RuntimeError("wav 必须是单声道，实际 %d 声道" % channels)
    if rate != SAMPLE_RATE:
        raise RuntimeError("wav 必须是 16kHz，实际 %dHz" % rate)
    if width != 2:
        raise RuntimeError("wav 必须是 16bit PCM，实际 %d 字节/采样" % width)
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    duration = len(audio) / float(SAMPLE_RATE) if len(audio) else 0.0
    return audio, duration


def main() -> int:
    parser = argparse.ArgumentParser(description="faster-whisper 中文转写")
    parser.add_argument("audio", help="wav 音频路径（16k 单声道）")
    parser.add_argument("--offset", type=float, default=0.0, help="该分片在整节课中的起始秒数")
    parser.add_argument("--model-dir", default="", help="模型缓存目录（HF cache 布局）")
    parser.add_argument("--model", default="small", help="模型名，默认 small")
    parser.add_argument("--language", default="zh", help="语言，默认 zh")
    parser.add_argument("--beam-size", type=int, default=5)
    args = parser.parse_args()

    # Windows 重定向到文件时默认可能是 GBK，强制 UTF-8，避免中文 JSON 编码失败
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isfile(args.audio):
        print("音频文件不存在: %s" % args.audio, file=sys.stderr)
        return 1

    try:
        samples, duration = load_wav_16k_mono(args.audio)
    except Exception as exc:  # noqa: BLE001
        print("音频读取失败: %s" % exc, file=sys.stderr)
        return 2

    if len(samples) == 0:
        payload = {
            "segments": [],
            "duration": 0.0,
            "offsetSec": round(float(args.offset), 2),
            "language": args.language,
            "model": args.model,
            "empty": True,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print("无法导入 faster_whisper: %s" % exc, file=sys.stderr)
        return 3

    kwargs = {"device": "cpu", "compute_type": "int8"}
    if args.model_dir:
        try:
            os.makedirs(args.model_dir, exist_ok=True)
        except Exception as exc:  # noqa: BLE001
            print("模型目录不可写（%s）：%s" % (args.model_dir, exc), file=sys.stderr)
            return 3
        kwargs["download_root"] = args.model_dir

    try:
        model = WhisperModel(args.model, **kwargs)
    except Exception as exc:  # noqa: BLE001
        print("模型加载失败: %s" % exc, file=sys.stderr)
        return 4

    try:
        # 传 numpy 数组：绕过 faster-whisper 内部 PyAV 解码（见文件头说明）
        segments, info = model.transcribe(
            samples,
            language=args.language,
            vad_filter=True,
            beam_size=args.beam_size,
            condition_on_previous_text=False,
        )
        out = []
        for seg in segments:
            text = (getattr(seg, "text", "") or "").strip()
            if not text:
                continue
            out.append({
                "start": round(float(getattr(seg, "start", 0.0) or 0.0), 2),
                "end": round(float(getattr(seg, "end", 0.0) or 0.0), 2),
                "text": text,
            })
        info_duration = float(getattr(info, "duration", 0.0) or 0.0)
        payload = {
            "segments": out,
            "duration": round(info_duration or duration, 2),
            "offsetSec": round(float(args.offset), 2),
            "language": getattr(info, "language", args.language),
            "model": args.model,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print("转写失败: %s" % exc, file=sys.stderr)
        return 5


if __name__ == "__main__":
    sys.exit(main())
