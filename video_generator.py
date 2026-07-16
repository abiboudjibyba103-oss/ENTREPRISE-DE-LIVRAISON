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
                    "Ces mots-clés doivent décrire UNIQUEMENT des hommes noirs "
                    "africains âgés de 20 à 35 ans. Ils doivent être très "
                    'spécifiques, par exemple : "young black african man stressed", '
                    '"african male student laptop", "black man thinking desk", '
                    '"african man studying", "young black entrepreneur man".\n\n'
                    "INTERDICTION ABSOLUE d'utiliser des mots-clés génériques ou "
                    "ambigus qui pourraient retourner des personnes blanches, des "
                    "femmes, des enfants ou des animaux. Chaque mot-clé doit "
                    'obligatoirement contenir le mot "man" ou "male", et jamais '
                    '"woman" ou "female".\n\n'
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


_MOTS_INTERDITS = (
    "animal", "pet", "dog", "cat", "child", "kid", "baby", "white",
    "woman", "female", "girl", "lady",
)
_MOTS_REQUIS = ("black", "african")


def _hit_autorise(hit: dict) -> bool:
    """N'accepte que les vidéos explicitement taguées black/african, sans mot interdit.

    Un simple mot-clé de recherche ne garantit pas que Pixabay retourne des
    vidéos correspondant réellement à des hommes noirs africains — beaucoup de
    résultats n'ont aucune indication d'origine ethnique dans leurs tags. On
    exige donc explicitement "black" ou "african" dans les tags/titre, en plus
    d'exclure les mots interdits.
    """
    texte = f"{hit.get('tags', '')} {hit.get('title', '')}".lower()
    if any(mot in texte for mot in _MOTS_INTERDITS):
        return False
    return any(mot in texte for mot in _MOTS_REQUIS)


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

            if not _hit_autorise(hit):
                continue

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


def _executer_ffmpeg(commande: list) -> None:
    print("Commande FFmpeg :")
    print(" ".join(commande))

    resultat = subprocess.run(commande, capture_output=True, text=True)

    if resultat.stderr:
        print(resultat.stderr)

    if resultat.returncode != 0:
        raise RuntimeError(f"Échec de la commande FFmpeg (code {resultat.returncode}).")


def _dimensions_plateforme(platform: str) -> tuple:
    plateforme_normalisee = platform.lower()
    if plateforme_normalisee == "tiktok":
        return 1080, 1920  # vertical 9:16
    if plateforme_normalisee in ("instagram", "facebook"):
        return 1080, 1080  # carré 1:1
    return 1920, 1080  # horizontal 16:9 (YouTube)


def assemble_video(video_files: list, audio_file: str, output_path: str, platform: str) -> str:
    """Assemble les vidéos et la voix off en une vidéo finale via FFmpeg, en 3 étapes :

    1. Normalise chaque clip (résolution, SAR, framerate) dans temp_normalized/
    2. Écrit la liste des clips normalisés dans concat_list.txt
    3. Concatène les clips normalisés avec la voix off pour produire la vidéo finale

    Cette approche évite les problèmes de SAR et de résolutions différentes
    qui surviennent en assemblant directement des clips hétérogènes.
    """
    if not video_files:
        raise ValueError("Aucune vidéo disponible pour le montage.")

    largeur, hauteur = _dimensions_plateforme(platform)

    duree_audio = float(ffmpeg.probe(audio_file)["format"]["duration"])
    duree_par_clip = duree_audio / len(video_files)

    dossier_sortie = os.path.dirname(output_path)
    if dossier_sortie:
        os.makedirs(dossier_sortie, exist_ok=True)

    dossier_normalise = "temp_normalized"
    os.makedirs(dossier_normalise, exist_ok=True)

    fondu_debut = FONDU_SECONDES
    fondu_fin = max(duree_par_clip - FONDU_SECONDES, 0)
    filtre_video = (
        f"scale={largeur}:{hauteur}:force_original_aspect_ratio=decrease,"
        f"pad={largeur}:{hauteur}:(ow-iw)/2:(oh-ih)/2,setsar=1/1,"
        f"fade=t=in:st=0:d={fondu_debut},"
        f"fade=t=out:st={fondu_fin}:d={FONDU_SECONDES}"
    )

    # Étape 1 : normalise chaque clip (résolution, SAR, framerate identiques)
    clips_normalises = []
    for i, chemin_video in enumerate(video_files):
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


# --- Sous-titres ---

_MOTS_PAR_GROUPE = 4
_DUREE_MAX_SOUS_TITRE = 2.0  # secondes — aucun sous-titre ne reste plus longtemps
_PONCTUATION_RE = re.compile(r"[^\wÀ-ÿ'’-]")


def _grouper_mots(mots: list) -> list:
    """Regroupe les mots par 3-4, sans dépasser la durée d'affichage maximale."""
    groupes = []
    groupe_courant = []
    debut_groupe = None

    for mot in mots:
        texte = _PONCTUATION_RE.sub("", mot["text"]).strip()
        if not texte:
            continue

        if not groupe_courant:
            debut_groupe = mot["debut"]

        groupe_courant.append(texte)
        duree_ecoulee = mot["fin"] - debut_groupe

        if len(groupe_courant) >= _MOTS_PAR_GROUPE or duree_ecoulee >= _DUREE_MAX_SOUS_TITRE:
            groupes.append({"texte": " ".join(groupe_courant), "debut": debut_groupe, "fin": mot["fin"]})
            groupe_courant = []

    if groupe_courant:
        groupes.append({"texte": " ".join(groupe_courant), "debut": debut_groupe, "fin": mots[-1]["fin"]})

    return groupes


def _formater_temps_ass(secondes: float) -> str:
    heures = int(secondes // 3600)
    minutes = int((secondes % 3600) // 60)
    secs = secondes % 60
    centiemes = int(round((secs - int(secs)) * 100))
    return f"{heures}:{minutes:02d}:{int(secs):02d}.{centiemes:02d}"


def generer_fichier_sous_titres(mots: list, platform: str, chemin_sortie: str) -> str:
    """Génère un fichier .ass de sous-titres stylés selon les règles Prédicta.

    Police Arial Bold, contour noir épais, texte jaune vif, bas de l'écran
    centré, 3-4 mots par groupe max 2 secondes à l'écran, sans ponctuation,
    en majuscules pour TikTok/Instagram et en minuscules pour YouTube.
    """
    plateforme_normalisee = platform.lower()
    taille = 14 if plateforme_normalisee == "youtube" else 18
    majuscules = plateforme_normalisee != "youtube"
    largeur, hauteur = _dimensions_plateforme(platform)

    groupes = _grouper_mots(mots)

    lignes = [
        "[Script Info]\n",
        "ScriptType: v4.00+\n",
        f"PlayResX: {largeur}\n",
        f"PlayResY: {hauteur}\n",
        "\n",
        "[V4+ Styles]\n",
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Outline, Alignment, MarginV\n",
        f"Style: Predicta,Arial,{taille},&H0000FFFF,&H00000000,-1,3,2,40\n",
        "\n",
        "[Events]\n",
        "Format: Layer, Start, End, Style, Text\n",
    ]

    for groupe in groupes:
        texte = groupe["texte"].upper() if majuscules else groupe["texte"].lower()
        debut = _formater_temps_ass(groupe["debut"])
        fin = _formater_temps_ass(groupe["fin"])
        lignes.append(f"Dialogue: 0,{debut},{fin},Predicta,{texte}\n")

    with open(chemin_sortie, "w", encoding="utf-8") as f:
        f.writelines(lignes)

    return chemin_sortie


def _chemin_pour_filtre_ffmpeg(chemin: str) -> str:
    """Échappe un chemin de fichier pour l'utiliser dans un filtre FFmpeg (ass=, subtitles=).

    Les ':' et '\\' cassent le parseur de filtres FFmpeg (fréquent sur Windows) —
    on convertit en chemin absolu, slashs uniquement, et on échappe les ':'.
    """
    chemin_abs = os.path.abspath(chemin).replace("\\", "/")
    return chemin_abs.replace(":", "\\:")


def add_subtitles(video_path: str, mots: list, platform: str) -> str:
    """Brûle les sous-titres stylés dans la vidéo assemblée, à partir du timing des mots."""
    if not mots:
        print(
            "Aucun timing de mot reçu — les sous-titres sont ignorés "
            "(vérifie que generate_voice() a bien capturé les WordBoundary d'Edge TTS)."
        )
        return video_path

    chemin_ass = os.path.splitext(video_path)[0] + ".ass"
    generer_fichier_sous_titres(mots, platform, chemin_ass)
    print(f"Fichier de sous-titres généré : {chemin_ass} ({len(mots)} mots)")

    chemin_temp = os.path.splitext(video_path)[0] + "_sous_titres.mp4"
    _executer_ffmpeg([
        "ffmpeg",
        "-i", video_path,
        "-vf", f"ass={_chemin_pour_filtre_ffmpeg(chemin_ass)}",
        "-c:v", "libx264",
        "-c:a", "copy",
        "-y",
        chemin_temp,
    ])

    os.replace(chemin_temp, video_path)
    return video_path
