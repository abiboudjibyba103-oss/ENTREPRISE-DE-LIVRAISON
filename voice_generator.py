"""Générateur de voix pour Prédicta via Edge TTS."""

import asyncio
import os
import re
import subprocess
import sys

try:
    import edge_tts
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "edge-tts"])
    import edge_tts

VOICE = "fr-FR-HenriNeural"  # voix masculine française, naturelle et gratuite


def _nettoyer_script(script_text: str) -> str:
    """Retire les balises markdown pour que la voix ne les lise pas."""
    texte = script_text.replace("**", "")
    texte = re.sub(r"^#+\s*", "", texte, flags=re.MULTILINE)
    texte = re.sub(r"^-{3,}\s*$", "", texte, flags=re.MULTILINE)
    texte = texte.replace("[", "").replace("]", "")
    return texte.strip()


async def _synthetiser(texte: str, chemin_audio: str) -> None:
    communicate = edge_tts.Communicate(texte, VOICE)
    await communicate.save(chemin_audio)


def generate_voice(script_text: str, output_filename: str) -> str:
    """Génère un fichier audio MP3 à partir d'un script texte via Edge TTS."""
    os.makedirs("audio", exist_ok=True)

    texte_propre = _nettoyer_script(script_text)
    chemin_audio = os.path.join("audio", output_filename)

    asyncio.run(_synthetiser(texte_propre, chemin_audio))

    return chemin_audio
