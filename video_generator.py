"""Générateur de vidéo pour Prédicta : visuels Pixabay + voix off assemblés via FFmpeg."""

import concurrent.futures
import json
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


_REGLES_MOTS_CLES = """Règles strictes et permanentes de ciblage des mots-clés (s'appliquent à
CHAQUE section, pour cette réponse comme pour toutes les suivantes) :
- Sur l'ensemble des mots-clés de cette réponse, 85% doivent cibler explicitement des hommes
  noirs africains de 20 à 35 ans, avec des termes comme "young black african man",
  "black male student", "african young man desk".
- Maximum 15% des mots-clés peuvent cibler des femmes noires africaines (même tranche d'âge).
- ZÉRO personne blanche : si un mot-clé risque de retourner des personnes blanches, reformule-le
  pour qu'il cible sans ambiguïté des personnes noires africaines.
- Chaque mot-clé doit obligatoirement contenir "african" ou "black man", sauf s'il s'agit d'une
  animation abstraite (comme le cerveau) qui ne montre aucune personne.
- Bons exemples de mots-clés : "young black african man thinking", "african male student laptop",
  "black man stressed work desk".

Règles de correspondance thème → mot-clé (à respecter à la lettre quand le thème de la
section correspond), en gardant toujours le ciblage ci-dessus :
- Le cerveau, la neuroscience, le fonctionnement mental → "brain neuroscience animation"
- La procrastination → "young black african man procrastinating desk"
- Le téléphone, les notifications, les distractions → "young black african man phone distracted"
- Le stress, la pression, la charge mentale → "black man stressed work desk"
- La motivation, la réussite, l'ambition → "young black african man entrepreneur success"

Pour tout autre thème qui ne correspond à aucune de ces règles, invente un mot-clé tout aussi
précis et visuel, en respectant impérativement les règles de ciblage ci-dessus.
INTERDICTION ABSOLUE de mots-clés pouvant retourner des enfants ou des animaux."""


_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$")


def extract_keywords_per_section(sections: list) -> list:
    """Extrait un mot-clé vidéo Pixabay précis pour chaque section du script.

    Une section correspond à un bloc du script délimité par '---'. Chaque mot-clé
    décrit exactement ce qui est dit dans sa section (et non le script entier),
    pour que le visuel corresponde au propos du moment. Un seul appel à Claude
    traite toutes les sections d'un coup (au lieu d'un appel par section) pour
    réduire la latence totale. Retourne une liste de mots-clés dans le même
    ordre que `sections`.
    """
    sections_numerotees = "\n\n".join(
        f"Section {i + 1} :\n{section}" for i, section in enumerate(sections)
    )

    response = _client.messages.create(
        model=MODEL,
        max_tokens=max(256, 64 * len(sections)),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Voici les {len(sections)} sections d'un script vidéo pour Prédicta, "
                    "chacune numérotée :\n\n"
                    f"{sections_numerotees}\n\n"
                    "Pour CHAQUE section, donne un mot-clé de recherche vidéo Pixabay, en "
                    "anglais, très précis, qui illustre exactement ce qui est dit dans "
                    "cette section précise (pas le script entier).\n\n"
                    f"{_REGLES_MOTS_CLES}\n\n"
                    "Retourne UNIQUEMENT un objet JSON de cette forme, sans texte avant ni "
                    "après, sans balises de code markdown :\n"
                    '{"mots_cles": ["mot-clé section 1", "mot-clé section 2", ...]}\n\n'
                    f"Le tableau doit contenir exactement {len(sections)} mots-clés, dans "
                    "l'ordre des sections."
                ),
            }
        ],
    )

    texte_reponse = _CODE_FENCE_RE.sub("", response.content[0].text.strip())
    mots_cles = json.loads(texte_reponse)["mots_cles"]

    if len(mots_cles) != len(sections):
        raise RuntimeError(
            f"Claude a renvoyé {len(mots_cles)} mots-clés pour {len(sections)} sections."
        )

    return [mot_cle.strip() for mot_cle in mots_cles]


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


def _telecharger_video_section(index: int, mot_cle: str, output_dir: str) -> str:
    """Recherche et télécharge la vidéo Pixabay retenue pour une section."""
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

    video_url = hit_retenu.get("videos", {}).get("small", {}).get("url")
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

    return chemin_video


def download_videos(keywords: list, output_dir: str, max_workers: int = 4) -> list:
    """Télécharge UNE vidéo Pixabay par mot-clé (une par section du script), en
    parallélisant les téléchargements (jusqu'à `max_workers` à la fois).

    Retourne les chemins dans le même ordre que `keywords` — ThreadPoolExecutor.map
    préserve cet ordre même si les téléchargements se terminent dans le désordre —
    pour garder une correspondance 1:1 entre chaque section et son clip vidéo,
    nécessaire pour qu'assemble_video() puisse aligner chaque clip sur sa section.
    """
    os.makedirs(output_dir, exist_ok=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        chemins_videos = list(
            executor.map(
                lambda item: _telecharger_video_section(item[0], item[1], output_dir),
                enumerate(keywords),
            )
        )

    return chemins_videos


def _executer_ffmpeg(commande: list) -> None:
    print("Commande FFmpeg :")
    print(" ".join(commande))

    resultat = subprocess.run(commande, capture_output=True, text=True)

    if resultat.stderr:
        print(resultat.stderr)

    if resultat.returncode != 0:
        raise RuntimeError(f"Échec de la commande FFmpeg (code {resultat.returncode}).")


def assemble_video(
    video_files: list,
    audio_file: str,
    output_path: str,
    platform: str,
    durees_sections: list,
    dossier_normalise: str,
) -> str:
    """Assemble les vidéos et la voix off en une vidéo finale via FFmpeg, en 3 étapes :

    1. Normalise chaque clip (résolution, SAR, framerate) dans `dossier_normalise`,
       chacun découpé à la durée audio exacte de sa section correspondante
    2. Écrit la liste des clips normalisés dans concat_list.txt
    3. Concatène les clips normalisés avec la voix off pour produire la vidéo finale

    Cette approche évite les problèmes de SAR et de résolutions différentes
    qui surviennent en assemblant directement des clips hétérogènes.

    `video_files` et `durees_sections` doivent être alignés un-à-un (le clip i
    illustre la section dont la durée audio réelle est durees_sections[i]) —
    voir voice_generator.generate_voice_per_section(), qui renvoie ces durées.

    `dossier_normalise` est un dossier temporaire propre à cette génération
    (nommé par l'appelant, par exemple avec un timestamp) : cette fonction ne
    le supprime pas elle-même, c'est à l'appelant de le nettoyer une fois la
    génération terminée.
    """
    if not video_files:
        raise ValueError("Aucune vidéo disponible pour le montage.")

    if len(video_files) != len(durees_sections):
        raise ValueError(
            "Il doit y avoir exactement une vidéo par section "
            f"({len(video_files)} vidéos pour {len(durees_sections)} sections)."
        )

    plateforme_normalisee = platform.lower()
    if plateforme_normalisee == "tiktok":
        largeur, hauteur = 1080, 1920  # vertical 9:16
    elif plateforme_normalisee in ("instagram", "facebook"):
        largeur, hauteur = 1080, 1080  # carré 1:1
    else:
        largeur, hauteur = 1920, 1080  # horizontal 16:9 (YouTube)

    dossier_sortie = os.path.dirname(output_path)
    if dossier_sortie:
        os.makedirs(dossier_sortie, exist_ok=True)

    os.makedirs(dossier_normalise, exist_ok=True)

    # Étape 1 : normalise chaque clip (résolution, SAR, framerate identiques)
    # à la durée exacte de sa section
    clips_normalises = []
    for i, (chemin_video, duree_par_clip) in enumerate(zip(video_files, durees_sections)):
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
            "-preset", "ultrafast",
            "-crf", "23",
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
