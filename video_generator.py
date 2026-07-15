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


_REGLES_MOTS_CLES = """Règles strictes de correspondance thème → mot-clé (à respecter à la lettre
quand le thème de la section correspond) :
- Le cerveau, la neuroscience, le fonctionnement mental → "brain neuroscience animation"
- La procrastination → "young black man procrastinating desk"
- Le téléphone, les notifications, les distractions → "young african man phone distracted"
- Le stress, la pression, la charge mentale → "young black man stressed work"
- La motivation, la réussite, l'ambition → "young african entrepreneur success"

Pour tout autre thème qui ne correspond à aucune de ces règles, invente un mot-clé
tout aussi précis et visuel, en respectant impérativement ces contraintes :
- Les personnes représentées doivent TOUJOURS être noires, africaines, âgées de 20 à 35 ans.
- Le mot-clé doit obligatoirement contenir "black" ou "african", sauf s'il s'agit d'une
  animation abstraite (comme le cerveau) qui ne montre aucune personne.
- INTERDICTION ABSOLUE de mots-clés pouvant retourner des enfants, des animaux ou des
  personnes blanches."""


def extract_keywords_per_section(sections: list) -> list:
    """Extrait un mot-clé vidéo Pixabay précis pour chaque section du script.

    Une section correspond à un bloc du script délimité par '---'. Chaque mot-clé
    décrit exactement ce qui est dit dans sa section (et non le script entier),
    pour que le visuel corresponde au propos du moment. Retourne une liste de
    mots-clés dans le même ordre que `sections`.
    """
    mots_cles = []

    for section in sections:
        response = _client.messages.create(
            model=MODEL,
            max_tokens=64,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Voici une section d'un script vidéo pour Prédicta :\n\n"
                        f"{section}\n\n"
                        "Donne UN SEUL mot-clé de recherche vidéo Pixabay, en anglais, "
                        "très précis, qui illustre exactement ce qui est dit dans cette "
                        "section (pas le script entier, juste cette section).\n\n"
                        f"{_REGLES_MOTS_CLES}\n\n"
                        "Retourne uniquement le mot-clé, sans numérotation, sans "
                        "explication, sans guillemets."
                    ),
                }
            ],
        )
        mot_cle = response.content[0].text.strip().strip('"').splitlines()[0].strip()
        mots_cles.append(mot_cle)

    return mots_cles


def _rechercher_pixabay(mot_cle: str) -> list:
    url = f"https://pixabay.com/api/videos/?key={PIXABAY_API_KEY}&q={quote(mot_cle)}&per_page=3"
    response = requests.get(url, verify=False)
    response.raise_for_status()
    return response.json().get("hits", [])


def _slugifier(texte: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", texte.lower()).strip("_")


_MOTS_INTERDITS = ("animal", "pet", "dog", "cat", "child", "kid", "baby", "white")


def _hit_autorise(hit: dict) -> bool:
    """Rejette les vidéos dont les tags/titre contiennent un mot interdit."""
    texte = f"{hit.get('tags', '')} {hit.get('title', '')}".lower()
    return not any(mot in texte for mot in _MOTS_INTERDITS)


def download_videos(keywords: list, output_dir: str) -> list:
    """Télécharge UNE vidéo Pixabay par mot-clé (une par section du script).

    Retourne les chemins dans le même ordre que `keywords`, pour garder une
    correspondance 1:1 entre chaque section et son clip vidéo — nécessaire
    pour qu'assemble_video() puisse aligner chaque clip sur sa section.
    """
    os.makedirs(output_dir, exist_ok=True)
    chemins_videos = []

    for index, mot_cle in enumerate(keywords):
        hits = _rechercher_pixabay(mot_cle)

        if not hits:
            mot_cle_simplifie = re.sub(
                r"\b(african|black)\b", "", mot_cle, flags=re.IGNORECASE
            ).strip()
            mot_cle_simplifie = re.sub(r"\s+", " ", mot_cle_simplifie)
            if mot_cle_simplifie and mot_cle_simplifie != mot_cle:
                hits = _rechercher_pixabay(mot_cle_simplifie)

        hit_retenu = next((hit for hit in hits if _hit_autorise(hit)), None)
        if hit_retenu is None:
            raise RuntimeError(
                f"Aucun visuel autorisé trouvé pour le mot-clé « {mot_cle} » (section {index + 1})."
            )

        video_url = hit_retenu.get("videos", {}).get("medium", {}).get("url")
        if not video_url:
            raise RuntimeError(
                f"Aucune URL vidéo disponible pour le mot-clé « {mot_cle} » (section {index + 1})."
            )

        chemin_video = os.path.join(
            output_dir, f"section_{index}_{_slugifier(mot_cle)}_{hit_retenu.get('id')}.mp4"
        )
        video_response = requests.get(video_url)
        video_response.raise_for_status()

        with open(chemin_video, "wb") as f:
            f.write(video_response.content)

        chemins_videos.append(chemin_video)

    return chemins_videos


def _executer_ffmpeg(commande: list) -> None:
    print("Commande FFmpeg :")
    print(" ".join(commande))

    resultat = subprocess.run(commande, capture_output=True, text=True)

    if resultat.stderr:
        print(resultat.stderr)

    if resultat.returncode != 0:
        raise RuntimeError(f"Échec de la commande FFmpeg (code {resultat.returncode}).")


def _durees_par_section(sections: list, duree_audio: float) -> list:
    """Répartit la durée totale de la voix off entre les sections, au prorata
    du nombre de mots de chaque section (proxy du temps de lecture de chacune),
    de façon à ce que chaque clip dure aussi longtemps que le texte qu'il illustre.
    """
    poids_sections = [max(len(section.split()), 1) for section in sections]
    poids_total = sum(poids_sections)
    return [duree_audio * poids / poids_total for poids in poids_sections]


def assemble_video(
    video_files: list, audio_file: str, output_path: str, platform: str, sections: list
) -> str:
    """Assemble les vidéos et la voix off en une vidéo finale via FFmpeg, en 3 étapes :

    1. Normalise chaque clip (résolution, SAR, framerate) dans temp_normalized/,
       chacun découpé à la durée exacte de sa section correspondante
    2. Écrit la liste des clips normalisés dans concat_list.txt
    3. Concatène les clips normalisés avec la voix off pour produire la vidéo finale

    Cette approche évite les problèmes de SAR et de résolutions différentes
    qui surviennent en assemblant directement des clips hétérogènes.

    `video_files` et `sections` doivent être alignés un-à-un (le clip i illustre
    la section i) : c'est cet alignement qui permet de donner à chaque clip la
    durée de la section qu'il illustre plutôt qu'une durée moyenne.
    """
    if not video_files:
        raise ValueError("Aucune vidéo disponible pour le montage.")

    if len(video_files) != len(sections):
        raise ValueError(
            "Il doit y avoir exactement une vidéo par section "
            f"({len(video_files)} vidéos pour {len(sections)} sections)."
        )

    plateforme_normalisee = platform.lower()
    if plateforme_normalisee == "tiktok":
        largeur, hauteur = 1080, 1920  # vertical 9:16
    elif plateforme_normalisee in ("instagram", "facebook"):
        largeur, hauteur = 1080, 1080  # carré 1:1
    else:
        largeur, hauteur = 1920, 1080  # horizontal 16:9 (YouTube)

    duree_audio = float(ffmpeg.probe(audio_file)["format"]["duration"])
    durees_clips = _durees_par_section(sections, duree_audio)

    dossier_sortie = os.path.dirname(output_path)
    if dossier_sortie:
        os.makedirs(dossier_sortie, exist_ok=True)

    dossier_normalise = "temp_normalized"
    os.makedirs(dossier_normalise, exist_ok=True)

    # Étape 1 : normalise chaque clip (résolution, SAR, framerate identiques)
    # à la durée exacte de sa section
    clips_normalises = []
    for i, (chemin_video, duree_par_clip) in enumerate(zip(video_files, durees_clips)):
        fondu_fin = max(duree_par_clip - FONDU_SECONDES, 0)
        filtre_video = (
            f"scale={largeur}:{hauteur}:force_original_aspect_ratio=decrease,"
            f"pad={largeur}:{hauteur}:(ow-iw)/2:(oh-ih)/2,setsar=1/1,"
            f"fade=t=in:st=0:d={FONDU_SECONDES},"
            f"fade=t=out:st={fondu_fin}:d={FONDU_SECONDES}"
        )

        chemin_normalise = os.path.join(dossier_normalise, f"clip_{i}.mp4")
        _executer_ffmpeg([
            "ffmpeg",
            "-stream_loop", "-1",
            "-i", chemin_video,
            "-vf", filtre_video,
            "-t", str(duree_par_clip),
            "-r", "30",
            "-c:v", "libx264",
            "-preset", "slow",
            "-crf", "18",
            chemin_normalise,
            "-y",
        ])
        clips_normalises.append(chemin_normalise)

    # Étape 2 : liste des clips normalisés pour le concat demuxer
    chemin_liste = "concat_list.txt"
    with open(chemin_liste, "w", encoding="utf-8") as f:
        for chemin_clip in clips_normalises:
            f.write(f"file '{chemin_clip}'\n")

    # Étape 3 : concatène les clips normalisés avec la voix off (mapping explicite
    # pour garantir que la piste audio soit bien incluse dans la sortie finale)
    _executer_ffmpeg([
        "ffmpeg",
        "-f", "concat",
        "-safe", "0",
        "-i", chemin_liste,
        "-i", audio_file,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        "-y",
        output_path,
    ])

    return output_path
