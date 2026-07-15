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


async def _synthetiser_phrase_avec_mots(phrase: str, chemin: str) -> list:
    """Synthétise une phrase, écrit son audio dans `chemin` et retourne les
    limites de mots (texte, début, durée en secondes) rapportées par Edge TTS
    en direct pendant la synthèse — relatives au début de cette phrase."""
    communicate = edge_tts.Communicate(phrase, VOICE, rate="+25%")
    limites = []

    with open(chemin, "wb") as f:
        async for morceau in communicate.stream():
            if morceau["type"] == "audio":
                f.write(morceau["data"])
            elif morceau["type"] == "WordBoundary":
                limites.append(
                    {
                        "text": morceau["text"],
                        "debut": morceau["offset"] / 10_000_000,
                        "duree": morceau["duration"] / 10_000_000,
                    }
                )

    return limites


async def _synthetiser_plusieurs_avec_mots(phrases: list, chemins: list) -> list:
    return await asyncio.gather(
        *(
            _synthetiser_phrase_avec_mots(phrase, chemin)
            for phrase, chemin in zip(phrases, chemins)
        )
    )


def _synthetiser_section(phrases: list, dossier_temp: str, prefixe: str) -> tuple:
    """Synthétise les phrases d'une section, les recolle en un seul
    AudioSegment (séparées par la pause fixe PAUSE_MS) et retourne aussi la
    liste des mots prononcés avec leur timing réel (texte, début, durée en
    secondes), relatif au début de cette section — utilisée pour synchroniser
    les sous-titres mot à mot sur la voix off effectivement générée."""
    if not phrases:
        return AudioSegment.empty(), []

    chemins = [os.path.join(dossier_temp, f"{prefixe}_phrase_{i}.mp3") for i in range(len(phrases))]
    limites_par_phrase = asyncio.run(_synthetiser_plusieurs_avec_mots(phrases, chemins))

    pause = AudioSegment.silent(duration=PAUSE_MS)
    audio_section = AudioSegment.empty()
    mots_section = []
    curseur = 0.0
    for i, (chemin_phrase, limites) in enumerate(zip(chemins, limites_par_phrase)):
        segment_phrase = AudioSegment.from_file(chemin_phrase, format="mp3")

        for limite in limites:
            mots_section.append(
                {
                    "text": limite["text"],
                    "debut": curseur + limite["debut"],
                    "duree": limite["duree"],
                }
            )

        audio_section += segment_phrase
        curseur += len(segment_phrase) / 1000.0

        if i < len(chemins) - 1:
            audio_section += pause
            curseur += PAUSE_MS / 1000.0

    return audio_section, mots_section


def generate_voice_per_section(sections: list, output_filename: str) -> tuple:
    """Génère un unique fichier audio MP3 à partir des sections du script,
    en synthétisant chaque section séparément via Edge TTS.

    Synthétiser section par section (plutôt que le script entier d'un bloc)
    permet de connaître la durée audio réelle de chaque section : le clip
    vidéo qui l'illustre peut alors durer exactement ce temps-là, au lieu
    d'une estimation proportionnelle au nombre de mots.

    Retourne (chemin_audio, durees_sections, mots_avec_timing) :
    - le chemin du MP3 final ;
    - la liste des durées (en secondes) de chaque section dans cet audio,
      dans le même ordre que `sections`. La pause entre deux sections est
      comptée dans la durée de la section qui la précède, de sorte que la
      somme des durées retournées soit exactement égale à la durée totale
      de l'audio ;
    - la liste, dans l'ordre, de chaque mot réellement prononcé avec son
      timing exact (texte, début, durée en secondes) dans l'audio final —
      capturé en direct via les événements WordBoundary d'Edge TTS, pas
      estimé — pour synchroniser les sous-titres mot à mot.
    """
    os.makedirs("audio", exist_ok=True)
    chemin_audio = os.path.join("audio", output_filename)
    pause = AudioSegment.silent(duration=PAUSE_MS)

    with tempfile.TemporaryDirectory() as dossier_temp:
        resultats_sections = [
            _synthetiser_section(_nettoyer_script(section), dossier_temp, f"section_{index}")
            for index, section in enumerate(sections)
        ]

        audio_final = AudioSegment.empty()
        durees_sections = []
        mots_avec_timing = []
        curseur_global = 0.0
        for i, (audio_section, mots_section) in enumerate(resultats_sections):
            for mot in mots_section:
                mots_avec_timing.append(
                    {
                        "text": mot["text"],
                        "debut": curseur_global + mot["debut"],
                        "duree": mot["duree"],
                    }
                )

            audio_final += audio_section
            duree_section = len(audio_section) / 1000.0
            curseur_global += duree_section

            if i < len(resultats_sections) - 1:
                audio_final += pause
                duree_section += PAUSE_MS / 1000.0
                curseur_global += PAUSE_MS / 1000.0

            durees_sections.append(duree_section)

        audio_final.export(chemin_audio, format="mp3")

    return chemin_audio, durees_sections, mots_avec_timing
