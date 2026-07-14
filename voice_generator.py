"""Générateur de voix pour Prédicta via l'API ElevenLabs."""

import os
import subprocess
import sys

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests"])
    import requests

try:
    from dotenv import load_dotenv
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-dotenv"])
    from dotenv import load_dotenv

load_dotenv()

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
VOICE_ID = "21m00Tcm4TlvDq8ikWAM"  # Rachel — voix claire et naturelle
MODEL_ID = "eleven_multilingual_v2"


def generate_voice(script_text: str, output_filename: str) -> str:
    """Génère un fichier audio MP3 à partir d'un script texte via ElevenLabs."""
    os.makedirs("audio", exist_ok=True)

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    payload = {
        "text": script_text,
        "model_id": MODEL_ID,
    }

    response = requests.post(url, headers=headers, json=payload)
    response.raise_for_status()

    chemin_audio = os.path.join("audio", output_filename)
    with open(chemin_audio, "wb") as f:
        f.write(response.content)

    return chemin_audio
