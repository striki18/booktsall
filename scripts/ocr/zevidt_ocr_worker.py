"""Local OCR worker for PaddleOCR and docTR. It never calls a remote OCR API."""

from __future__ import annotations

import argparse
import inspect
import os
import sys
from pathlib import Path
from typing import Any


def _allow_model_download() -> bool:
    return os.environ.get("ZEVIDT_OCR_ALLOW_MODEL_DOWNLOAD", "").strip().lower() == "true"


def _paddle_text(result: Any) -> list[str]:
    texts: list[str] = []
    if hasattr(result, "json"):
        result = result.json
    if isinstance(result, (list, tuple)):
        if len(result) >= 2:
            recognition = result[1]
            if isinstance(recognition, (list, tuple)) and recognition and isinstance(recognition[0], str):
                value = recognition[0].strip()
                return [value] if value else []
        for item in result:
            texts.extend(_paddle_text(item))
        return texts
    if isinstance(result, dict):
        nested = result.get("res")
        candidates = [result]
        if isinstance(nested, dict):
            candidates.append(nested)
        for candidate in candidates:
            values = candidate.get("rec_texts")
            if isinstance(values, (list, tuple)):
                texts.extend(str(value).strip() for value in values if str(value).strip())
        return texts
    return texts


def run_paddle(image_path: Path) -> list[str]:
    from paddleocr import PaddleOCR

    model_directories = (
        ("ZEVIDT_OCR_PADDLE_DET_MODEL_DIR", "text_detection_model_dir", "det_model_dir"),
        ("ZEVIDT_OCR_PADDLE_REC_MODEL_DIR", "text_recognition_model_dir", "rec_model_dir"),
        ("ZEVIDT_OCR_PADDLE_ORIENTATION_MODEL_DIR", "textline_orientation_model_dir", "cls_model_dir"),
    )
    configured_directories = [(env_name, env_value.strip(), v3_name, v2_name)
                              for env_name, v3_name, v2_name in model_directories
                              if (env_value := os.environ.get(env_name, ""))]
    if not _allow_model_download() and len(configured_directories) != len(model_directories):
        raise RuntimeError("PaddleOCR model directories are required unless model download is explicitly enabled")
    for _env_name, value, _v3_name, _v2_name in configured_directories:
        if not Path(value).is_dir():
            raise RuntimeError("Configured PaddleOCR model directory is unavailable")

    parameters = inspect.signature(PaddleOCR).parameters
    options: dict[str, Any] = {}
    # Paddle's oneDNN/PIR path can fail on Windows before recognition.
    # Keep the same models and use the verified plain-CPU path by default there.
    mkldnn = os.environ.get("ZEVIDT_OCR_PADDLE_ENABLE_MKLDNN")
    if mkldnn is not None:
        normalized = mkldnn.strip().lower()
        if normalized not in ("true", "false"):
            raise RuntimeError("Invalid PaddleOCR CPU acceleration setting")
        options["enable_mkldnn"] = normalized == "true"
    elif os.name == "nt":
        options["enable_mkldnn"] = False
    if "lang" in parameters:
        options["lang"] = "en"
    if "use_angle_cls" in parameters:
        options["use_angle_cls"] = True
    for _env_name, value, v3_name, v2_name in configured_directories:
        model_parameter = v3_name if v3_name in parameters else v2_name if v2_name in parameters else None
        if model_parameter:
            options[model_parameter] = value
        elif not _allow_model_download():
            raise RuntimeError("Configured PaddleOCR model path is unsupported by the installed version")
    if "use_textline_orientation" in parameters:
        options["use_textline_orientation"] = True

    engine = PaddleOCR(**options)
    if hasattr(engine, "predict"):
        result = engine.predict(str(image_path))
    else:
        result = engine.ocr(str(image_path), cls=True)
    if hasattr(result, "json"):
        result = result.json
    return _paddle_text(result)


def run_doctr(input_path: Path) -> list[str]:
    if not _allow_model_download():
        raise RuntimeError("docTR pretrained model download is disabled; enable it explicitly after reviewing setup")
    from doctr.io import DocumentFile
    from doctr.models import ocr_predictor

    if input_path.suffix.lower() == ".pdf":
        document = DocumentFile.from_pdf(str(input_path))
    else:
        document = DocumentFile.from_images(str(input_path))
    result = ocr_predictor(pretrained=True)(document).export()
    lines: list[str] = []
    for page in result.get("pages", []):
        for block in page.get("blocks", []):
            for line in block.get("lines", []):
                words = [str(word.get("value", "")).strip() for word in line.get("words", [])]
                text = " ".join(word for word in words if word)
                if text:
                    lines.append(text)
    return lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=("paddleocr", "doctr"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    args = parser.parse_args()
    if not args.input.is_file():
        print("OCR input file was not found", file=sys.stderr)
        return 2

    try:
        if args.engine == "paddleocr":
            texts = run_paddle(args.input)
        else:
            texts = run_doctr(args.input)
    except Exception:
        # Provider exceptions can include paths or document-derived information.
        print("Local OCR provider failed", file=sys.stderr)
        return 1

    print("\n".join(texts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
