import hashlib
import json
from pathlib import Path
import sys

import cv2
import rapidocr_onnxruntime
from rapidocr_onnxruntime import RapidOCR


def read_capture(value):
    cache = (Path(__file__).resolve().parents[1] / ".cache").resolve()
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError("invalid-capture-directory")
    directory = Path(value).resolve()
    if not directory.is_relative_to(cache):
        raise ValueError("private-cache-input-required")
    receipt = json.loads((directory / "receipt.json").read_text(encoding="utf-8-sig"))
    if receipt.get("schema") != "official-client-capture/1" or receipt.get("image") != "client.png":
        raise ValueError("unsupported-capture-receipt")
    image_path = directory / "client.png"
    encoded = image_path.read_bytes()
    if len(encoded) > 25 * 1024 * 1024 or hashlib.sha256(encoded).hexdigest() != receipt.get("imageSha256"):
        raise ValueError("capture-image-pin-mismatch")
    image = cv2.imread(str(image_path))
    if image is None or image.shape[:2] != (receipt.get("height"), receipt.get("width")):
        raise ValueError("capture-image-dimensions-mismatch")
    return image, receipt


def create_engine():
    models = Path(rapidocr_onnxruntime.__file__).resolve().parent / "models"
    paths = {"det_model_path": models / "ch_PP-OCRv4_det_infer.onnx",
             "rec_model_path": models / "ch_PP-OCRv4_rec_infer.onnx",
             "cls_model_path": models / "ch_ppocr_mobile_v2.0_cls_infer.onnx"}
    if not all(path.is_file() for path in paths.values()):
        raise ValueError("bundled-ocr-model-unavailable")
    return RapidOCR(**{key: str(value) for key, value in paths.items()})


def recognize(directory, engine):
    image, receipt = read_capture(directory)
    result, _ = engine(image, use_cls=False)
    words = [{"text": text, "confidence": float(confidence),
              "polygon": [[float(x), float(y)] for x, y in polygon]}
             for polygon, text, confidence in result or []]
    return {"schema": "official-client-ocr/1", "capture": {
        "width": receipt["width"], "height": receipt["height"],
        "capturedAt": receipt["capturedAt"], "imageSha256": receipt["imageSha256"]},
        "words": words}


def emit(output):
    sys.stdout.write(json.dumps(output, ensure_ascii=True, allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) != 2:
        raise ValueError("usage: official-client-ocr.py private-capture-directory|--serve")
    if sys.argv[1] != "--serve":
        emit(recognize(sys.argv[1], create_engine()))
        return
    engine = create_engine()
    emit({"schema": "official-client-ocr-service/1", "ready": True})
    for line in sys.stdin:
        request = None
        try:
            if len(line) > 16384:
                raise ValueError("request-too-large")
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get("id"), int) or isinstance(request["id"], bool) or request["id"] < 0:
                raise ValueError("invalid-request")
            if set(request) - {"id", "op", "directory"}:
                raise ValueError("unsupported-request-field")
            operation = request.get("op", "ocr")
            if operation == "ping":
                emit({"id": request["id"], "ok": True, "ready": True})
            elif operation == "close":
                emit({"id": request["id"], "ok": True, "closed": True})
                break
            elif operation == "ocr":
                emit({"id": request["id"], "ok": True, "result": recognize(request.get("directory"), engine)})
            else:
                raise ValueError("unsupported-operation")
        except Exception as error:
            known_errors = {"request-too-large", "invalid-request", "unsupported-request-field", "unsupported-operation",
                            "invalid-capture-directory", "private-cache-input-required", "unsupported-capture-receipt",
                            "capture-image-pin-mismatch", "capture-image-dimensions-mismatch", "bundled-ocr-model-unavailable"}
            code = str(error) if isinstance(error, ValueError) and str(error) in known_errors else "ocr-failed"
            emit({"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": code})


if __name__ == "__main__":
    main()
