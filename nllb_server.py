"""Tiny local translation service around NLLB-200.
Run: pip install flask transformers torch sentencepiece && python nllb_server.py
Use a local folder or another checkpoint with: NLLB_MODEL=/path/to/model python nllb_server.py
"""
import os
import torch
from flask import Flask, request, jsonify
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

MODEL = os.environ.get("NLLB_MODEL", "facebook/nllb-200-distilled-600M")
tok = None
model = None
ENG = None
app = Flask(__name__)

def load_model():
    global tok, model, ENG
    if model is not None:
        return
    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL).eval()
    ENG = tok.convert_tokens_to_ids("eng_Latn")

@app.get("/")
def index():
    return jsonify(
        service="NLLB translation server",
        status="running",
        model=MODEL,
        endpoints={"translate": "POST /translate", "health": "GET /health"},
    )

@app.get("/health")
def health():
    return jsonify(status="ok", model_loaded=model is not None)

@app.post("/translate")
def translate():
    load_model()
    d = request.get_json(silent=True)
    if not isinstance(d, dict):
        return jsonify(error="Expected a JSON object"), 400
    src = d.get("src")
    texts = d.get("texts")
    if not isinstance(src, str) or not src:
        return jsonify(error="src is required"), 400
    if not isinstance(texts, list) or not texts or not all(isinstance(text, str) for text in texts):
        return jsonify(error="texts must be a non-empty array of strings"), 400
    tok.src_lang = src
    enc = tok(texts, return_tensors="pt", padding=True, truncation=True, max_length=128)
    with torch.no_grad():
        out = model.generate(**enc, forced_bos_token_id=ENG, max_new_tokens=128, num_beams=4)
    return jsonify(translations=tok.batch_decode(out, skip_special_tokens=True))

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8001)
