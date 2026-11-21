"""Offline OCR-provider contract regressions; no models or network required."""
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import zevidt_ocr_worker as worker


class PaddleWorkerTests(unittest.TestCase):
    def setUp(self):
        self.options = {}
        options = self.options

        class FakePaddle:
            def __init__(self, **kwargs):
                options.update(kwargs)

            def predict(self, _path):
                return [{"rec_texts": ["Invoice ZV-2026-001"]}]

        self.module = types.SimpleNamespace(PaddleOCR=FakePaddle)
        self.image = Path("synthetic.png")

    def recognize(self, extra=None):
        env = {"ZEVIDT_OCR_ALLOW_MODEL_DOWNLOAD": "true", **(extra or {})}
        with patch.dict(os.environ, env, clear=True):
            with patch.dict(sys.modules, {"paddleocr": self.module}):
                return worker.run_paddle(self.image)

    def test_windows_uses_verified_plain_cpu_path(self):
        with patch.object(worker.os, "name", "nt"):
            self.assertEqual(self.recognize(), ["Invoice ZV-2026-001"])
        self.assertIs(self.options["enable_mkldnn"], False)

    def test_explicit_acceleration_override_is_preserved(self):
        self.recognize({"ZEVIDT_OCR_PADDLE_ENABLE_MKLDNN": "true"})
        self.assertIs(self.options["enable_mkldnn"], True)

    def test_invalid_acceleration_configuration_fails_explicitly(self):
        with self.assertRaisesRegex(RuntimeError, "Invalid PaddleOCR"):
            self.recognize({"ZEVIDT_OCR_PADDLE_ENABLE_MKLDNN": "invalid"})
        self.assertEqual(self.options, {})


class DoctrWorkerTests(unittest.TestCase):
    def test_preserves_lines_and_multiword_fields(self):
        payload = {"pages": [{"blocks": [{"lines": [
            {"words": [{"value": "Invoice:"}, {"value": "ZV-2026-001"}]},
            {"words": [{"value": "Vendor:"}, {"value": "Example"}, {"value": "Supplies"}, {"value": "Ltd"}]},
            {"words": [{"value": "  "}]},
        ]}]}]}

        class Document:
            @staticmethod
            def from_images(_path):
                return ["synthetic-image"]

        class Result:
            def export(self):
                return payload

        modules = {
            "doctr": types.ModuleType("doctr"),
            "doctr.io": types.SimpleNamespace(DocumentFile=Document),
            "doctr.models": types.SimpleNamespace(ocr_predictor=lambda **_kwargs: lambda _doc: Result()),
        }
        image = Path("synthetic.png")
        with patch.dict(os.environ, {"ZEVIDT_OCR_ALLOW_MODEL_DOWNLOAD": "true"}, clear=True):
            with patch.dict(sys.modules, modules):
                self.assertEqual(worker.run_doctr(image), [
                    "Invoice: ZV-2026-001", "Vendor: Example Supplies Ltd",
                ])

if __name__ == "__main__":
    unittest.main()
