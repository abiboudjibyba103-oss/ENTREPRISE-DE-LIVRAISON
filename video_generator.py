"""Générateur de vidéo pour Prédicta : visuels Pixabay + voix off assemblés via FFmpeg."""

import os
import re
import subprocess
import sys
from urllib.parse import quote

try:
    import anthropic
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "anthropic"])
    import anthropic

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests"])
    import requests

import urllib3

urllib3.disable_warnings()

try:
    import ffmpeg
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "ffmpeg-python"])
    import ffmpeg

try:
    from dotenv import load_dotenv
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-dotenv"])
    from dotenv import load_dotenv

load_dotenv()

PIXABAY_API_KEY = os.environ.get("PIXABAY_API_KEY")
MODEL = "claude-sonnet-4-6"
FONDU_SECONDES = 0.5

_client = anthropic.Anthropic()


def ffmpeg_disponible() -> bool:
    """Vérifie que FFmpeg est installé et accessible dans le PATH."""
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def extract_keywords(script_text: str) -> list:
    """Extrait 5 mots-clés visuels en anglais pour la recherche vidéo Pixabay."""
    response = _client.messages.create(
        model=MODEL,
        max_tokens=256,
        messages=[
            {
                "role": "user",
                "content": (
                    "Voici un script vidéo pour Prédicta :\n\n"
                    f"{script_text}\n\n"
                    "Extrais exactement 5 mots-clés visuels en anglais, adaptés à "
                    "une recherche de vidéos sur Pixabay, qui illustrent ce script.\n\n"
                    "Ces mots-clés doivent TOUJOURS représenter des réalités "
                    "africaines et des personnes noires — par exemple : "
                    '"african student studying", "black man thinking", '
                    '"african entrepreneur laptop", "black woman focus", '
                    '"african office work", "black person procrastinating", '
                    '"african youth motivation".\n\n'
                    "Retourne uniquement les 5 mots-clés, un par ligne, sans "
                    "numérotation ni explication."
                ),
            }
        ],
    )

    lignes = response.content[0].text.strip().splitlines()
    mots_cles = []
    for ligne in lignes:
        mot_cle = re.sub(r"^[\d\.\)\-\s]+", "", ligne).strip()
        if mot_cle:
            mots_cles.append(mot_cle)

    return mots_cles[:5]


def _rechercher_pixabay(mot_cle: str) -> list:
    url = f"https://pixabay.com/api/videos/?key={PIXABAY_API_KEY}&q={quote(mot_cle)}&per_page=3"
    response = requests.get(url, verify=False)
    response.raise_for_status()
    return response.json().get("hits", [])


def _slugifier(texte: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", texte.lower()).strip("_")


def download_videos(keywords: list, output_dir: str, count_per_keyword: int = 2) -> list:
    """Télécharge des vidéos Pixabay pour chaque mot-clé et retourne leurs chemins."""
    os.makedirs(output_dir, exist_ok=True)
    chemins_videos = []

    for mot_cle in keywords:
        hits = _rechercher_pixabay(mot_cle)

        if not hits:
            mot_cle_simplifie = re.sub(
                r"\b(african|black)\b", "", mot_cle, flags=re.IGNORECASE
            ).strip()
            mot_cle_simplifie = re.sub(r"\s+", " ", mot_cle_simplifie)
            if mot_cle_simplifie and mot_cle_simplifie != mot_cle:
                hits = _rechercher_pixabay(mot_cle_simplifie)

        telecharges = 0
        for hit in hits:
            if telecharges >= count_per_keyword:
                break

            video_url = hit.get("videos", {}).get("medium", {}).get("url")
            if not video_url:
                continue

            chemin_video = os.path.join(
                output_dir, f"{_slugifier(mot_cle)}_{hit.get('id')}.mp4"
            )
            video_response = requests.get(video_url)
            video_response.raise_for_status()

            with open(chemin_video, "wb") as f:
                f.write(video_response.content)

            chemins_videos.append(chemin_video)
            telecharges += 1

    return chemins_videos


def assemble_video(video_files: list, audio_file: str, output_path: str, platform: str) -> str:
    """Assemble les vidéos et la voix off en une vidéo finale via FFmpeg."""
    if not video_files:
        raise ValueError("Aucune vidéo disponible pour le montage.")

    if platform.lower() in ("tiktok", "instagram"):
        largeur, hauteur = 1080, 1920
    else:
        largeur, hauteur = 1920, 1080

    duree_audio = float(ffmpeg.probe(audio_file)["format"]["duration"])
    duree_par_clip = duree_audio / len(video_files)

    dossier_sortie = os.path.dirname(output_path)
    if dossier_sortie:
        os.makedirs(dossier_sortie, exist_ok=True)

    flux_video = []
    for chemin_video in video_files:
        flux = (
            ffmpeg
            .input(chemin_video, stream_loop=-1, t=duree_par_clip)
            .filter("scale", largeur, hauteur, force_original_aspect_ratio="decrease")
            .filter("pad", largeur, hauteur, "(ow-iw)/2", "(oh-ih)/2")
            .filter("fade", type="in", duration=FONDU_SECONDES, start_time=0)
            .filter(
                "fade",
                type="out",
                duration=FONDU_SECONDES,
                start_time=max(duree_par_clip - FONDU_SECONDES, 0),
            )
        )
        flux_video.append(flux)

    video_concatenee = ffmpeg.concat(*flux_video, v=1, a=0)
    audio_entree = ffmpeg.input(audio_file)

    (
        ffmpeg
        .output(
            video_concatenee,
            audio_entree,
            output_path,
            vcodec="libx264",
            acodec="aac",
            pix_fmt="yuv420p",
        )
        .global_args("-shortest")
        .overwrite_output()
        .run(quiet=True)
    )

    return output_path
