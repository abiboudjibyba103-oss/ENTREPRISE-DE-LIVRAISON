"""Générateur de voix pour Prédicta via Edge TTS."""

import asyncio
import os
import re
import subprocess
import sys
import tempfile

try:
    import edge_tts
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "edge-tts"])
    import edge_tts

try:
    from pydub import AudioSegment
    from pydub.silence import detect_leading_silence
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pydub"])
    from pydub import AudioSegment
    from pydub.silence import detect_leading_silence

try:
    import imageio_ffmpeg
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "imageio-ffmpeg"])
    import imageio_ffmpeg

AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()

VOICE = "fr-FR-HenriNeural"  # voix masculine française, naturelle et gratuite
PAUSE_MS = 150  # petite pause entre chaque phrase, juste pour marquer la fin

_HEADER_RE = re.compile(r"^#{1,6}\s*")
_SEPARATEUR_RE = re.compile(r"^[-=_*]{3,}$")
_CROCHETS_RE = re.compile(r"\[[^\]]*\]")
_GRAS_RE = re.compile(r"\*\*(.+?)\*\*")
_ITALIQUE_RE = re.compile(r"\*(.+?)\*")
_PREDICTA_MAJ_RE = re.compile(r"\bPR[ÉE]DICTA\b")
_NOTES_REALISATION_RE = re.compile(r"^#{0,6}\s*notes?\s+de\s+r[ée]alisation", re.IGNORECASE)
_METADONNEES_RE = re.compile(
    r"dur[ée]e estim[ée]e|d[ée]bit naturel|secondes|minutes", re.IGNORECASE
)
_PHRASE_SEPARATEUR_RE = re.compile(r"(?<=[.!?])\s+")


def _nettoyer_script(script_text: str) -> list:
    """Ne garde que les phrases pures destinées à être lues, une par élément."""
    lignes_utiles = []

    for ligne in script_text.splitlines():
        ligne_stripped = ligne.strip()

        if _NOTES_REALISATION_RE.match(ligne_stripped):
            break  # tout ce qui suit les notes de réalisation est ignoré

        if not ligne_stripped:
            continue

        if _HEADER_RE.match(ligne_stripped):
            continue  # titre markdown : ni les # ni le texte du titre ne sont lus

        if _SEPARATEUR_RE.match(ligne_stripped):
            continue

        if _METADONNEES_RE.search(ligne_stripped):
            continue  # métadonnées (durée estimée, débit naturel, secondes, minutes)

        # retire les balises entre crochets (timing, musique, métadonnées, etc.)
        ligne_propre = _CROCHETS_RE.sub("", ligne_stripped).strip()

        if not re.search(r"[A-Za-zÀ-ÿ0-9]", ligne_propre):
            continue  # ligne composée uniquement de symboles

        lignes_utiles.append(ligne_propre)

    texte = " ".join(lignes_utiles)
    texte = _GRAS_RE.sub(r"\1", texte)
    texte = _ITALIQUE_RE.sub(r"\1", texte)
    texte = _PREDICTA_MAJ_RE.sub("Prédicta", texte)
    texte = re.sub(r"\benjeux hauts\b", "enjeux-hauts", texte, flags=re.IGNORECASE)
    texte = re.sub(r" {2,}", " ", texte).strip()

    return [phrase.strip() for phrase in _PHRASE_SEPARATEUR_RE.split(texte) if phrase.strip()]


async def _synthetiser_phrase(phrase: str, chemin: str) -> list:
    """Synthétise une phrase et retourne le timing (en secondes) de chaque mot."""
    communicate = edge_tts.Communicate(phrase, VOICE)
    mots = []

    with open(chemin, "wb") as f:
        async for morceau in communicate.stream():
            if morceau["type"] == "audio":
                f.write(morceau["data"])
            elif morceau["type"] == "WordBoundary":
                mots.append(
                    {
                        "text": morceau["text"],
                        "debut": morceau["offset"] / 10_000_000,
                        "fin": (morceau["offset"] + morceau["duration"]) / 10_000_000,
                    }
                )

    return mots


def _rogner_silence(segment: AudioSegment) -> tuple:
    """Retire le silence en début/fin de segment (Edge TTS en ajoute un peu à chaque phrase).

    Retourne (segment_rogné, décalage_début_en_secondes) — le décalage sert à
    corriger le timing des mots, qui était calculé par rapport à l'audio non rogné.
    """
    debut_silence = detect_leading_silence(segment)
    fin_silence = detect_leading_silence(segment.reverse())
    fin = max(len(segment) - fin_silence, debut_silence)
    return segment[debut_silence:fin], debut_silence / 1000.0


async def _synthetiser_toutes(phrases: list, dossier_temp: str) -> list:
    resultats = [None] * len(phrases)

    async def _traiter(i: int, phrase: str) -> None:
        chemin = os.path.join(dossier_temp, f"phrase_{i}.mp3")
        mots = await _synthetiser_phrase(phrase, chemin)
        resultats[i] = (chemin, mots)

    await asyncio.gather(*(_traiter(i, phrase) for i, phrase in enumerate(phrases)))
    return resultats


def generate_voice(script_text: str, output_filename: str) -> tuple:
    """Génère un fichier audio MP3 à partir d'un script texte via Edge TTS.

    Chaque phrase est synthétisée séparément puis recollée avec une petite
    pause fixe (PAUSE_MS) entre chacune, pour un contrôle précis du silence
    entre phrases — plutôt que de dépendre des pauses variables d'Edge TTS.

    Retourne (chemin_audio, mots) où `mots` est la liste de tous les mots du
    script avec leur timing exact (en secondes) dans l'audio final assemblé
    — utilisé pour synchroniser les sous-titres.
    """
    os.makedirs("audio", exist_ok=True)

    phrases = _nettoyer_script(script_text)
    chemin_audio = os.path.join("audio", output_filename)

    with tempfile.TemporaryDirectory() as dossier_temp:
        resultats = asyncio.run(_synthetiser_toutes(phrases, dossier_temp))

        audio_final = AudioSegment.empty()
        pause = AudioSegment.silent(duration=PAUSE_MS)
        mots_globaux = []
        decalage_s = 0.0

        for i, (chemin_phrase, mots) in enumerate(resultats):
            segment = AudioSegment.from_file(chemin_phrase, format="mp3")
            segment, decalage_debut = _rogner_silence(segment)

            for mot in mots:
                mots_globaux.append(
                    {
                        "text": mot["text"],
                        "debut": max(mot["debut"] - decalage_debut, 0) + decalage_s,
                        "fin": max(mot["fin"] - decalage_debut, 0) + decalage_s,
                    }
                )

            audio_final += segment
            decalage_s += segment.duration_seconds

            if i < len(resultats) - 1:
                audio_final += pause
                decalage_s += PAUSE_MS / 1000

        audio_final.export(chemin_audio, format="mp3")

    print(f"Timing capté pour {len(mots_globaux)} mot(s) (pour les sous-titres).")

    return chemin_audio, mots_globaux
