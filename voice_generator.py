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
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pydub"])
    from pydub import AudioSegment

try:
    import imageio_ffmpeg
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "imageio-ffmpeg"])
    import imageio_ffmpeg

AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()

VOICE = "fr-FR-HenriNeural"  # voix masculine française, naturelle et gratuite
PAUSE_MS = 300  # petite pause entre chaque phrase, juste pour marquer la fin

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
    # les retours à la ligne créent des pauses trop longues à la lecture : on les
    # aplatit en un espace simple, sans toucher aux points qui marquent les
    # pauses courtes naturelles entre phrases
    texte = texte.replace("\n\n", " ").replace("\n", " ")
    texte = _GRAS_RE.sub(r"\1", texte)
    texte = _ITALIQUE_RE.sub(r"\1", texte)
    texte = _PREDICTA_MAJ_RE.sub("Prédicta", texte)
    texte = re.sub(r"\benjeux hauts\b", "enjeux-hauts", texte, flags=re.IGNORECASE)
    texte = re.sub(r" {2,}", " ", texte).strip()

    return [phrase.strip() for phrase in _PHRASE_SEPARATEUR_RE.split(texte) if phrase.strip()]


async def _synthetiser_phrase(phrase: str, chemin: str) -> None:
    communicate = edge_tts.Communicate(phrase, VOICE)
    await communicate.save(chemin)


async def _synthetiser_plusieurs(phrases: list, chemins: list) -> None:
    await asyncio.gather(
        *(_synthetiser_phrase(phrase, chemin) for phrase, chemin in zip(phrases, chemins))
    )


def _synthetiser_section(phrases: list, dossier_temp: str, prefixe: str) -> AudioSegment:
    """Synthétise les phrases d'une section et les recolle en un seul
    AudioSegment, séparées par la pause fixe PAUSE_MS."""
    if not phrases:
        return AudioSegment.empty()

    chemins = [os.path.join(dossier_temp, f"{prefixe}_phrase_{i}.mp3") for i in range(len(phrases))]
    asyncio.run(_synthetiser_plusieurs(phrases, chemins))

    pause = AudioSegment.silent(duration=PAUSE_MS)
    audio_section = AudioSegment.empty()
    for i, chemin_phrase in enumerate(chemins):
        audio_section += AudioSegment.from_file(chemin_phrase, format="mp3")
        if i < len(chemins) - 1:
            audio_section += pause

    return audio_section


def generate_voice_per_section(sections: list, output_filename: str) -> tuple:
    """Génère un unique fichier audio MP3 à partir des sections du script,
    en synthétisant chaque section séparément via Edge TTS.

    Synthétiser section par section (plutôt que le script entier d'un bloc)
    permet de connaître la durée audio réelle de chaque section : le clip
    vidéo qui l'illustre peut alors durer exactement ce temps-là, au lieu
    d'une estimation proportionnelle au nombre de mots.

    Retourne (chemin_audio, durees_sections) : le chemin du MP3 final, et la
    liste des durées (en secondes) de chaque section dans cet audio, dans le
    même ordre que `sections`. La pause entre deux sections est comptée dans
    la durée de la section qui la précède, de sorte que la somme des durées
    retournées soit exactement égale à la durée totale de l'audio.
    """
    os.makedirs("audio", exist_ok=True)
    chemin_audio = os.path.join("audio", output_filename)
    pause = AudioSegment.silent(duration=PAUSE_MS)

    with tempfile.TemporaryDirectory() as dossier_temp:
        audio_sections = [
            _synthetiser_section(_nettoyer_script(section), dossier_temp, f"section_{index}")
            for index, section in enumerate(sections)
        ]

        audio_final = AudioSegment.empty()
        durees_sections = []
        for i, audio_section in enumerate(audio_sections):
            audio_final += audio_section
            duree_section = len(audio_section) / 1000.0
            if i < len(audio_sections) - 1:
                audio_final += pause
                duree_section += PAUSE_MS / 1000.0
            durees_sections.append(duree_section)

        audio_final.export(chemin_audio, format="mp3")

    return chemin_audio, durees_sections
