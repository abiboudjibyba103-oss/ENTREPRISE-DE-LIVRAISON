"""Point d'entrée principal : génère un script vidéo complet pour Prédicta."""

import os
import re
import shutil
import sys
from datetime import datetime

from idea_engine import (
    ANGLE_1,
    ANGLE_2,
    ANGLE_3,
    ANGLE_4,
    ANGLE_5,
    ANGLE_6,
    ANGLE_7,
    ANGLE_8,
    INSTAGRAM,
    TIKTOK,
    YOUTUBE,
    filter_idea,
    generate_idea,
    generate_script,
    generate_subject,
)
from voice_generator import generate_voice_per_section
from video_generator import (
    assemble_video,
    download_videos,
    extract_keywords_per_section,
    ffmpeg_disponible,
)
from subtitle_generator import generate_subtitles

PLATEFORMES = {
    "1": ("YouTube", YOUTUBE),
    "2": ("TikTok", TIKTOK),
    "3": ("Instagram", INSTAGRAM),
}

ANGLES = {
    "1": ANGLE_1,
    "2": ANGLE_2,
    "3": ANGLE_3,
    "4": ANGLE_4,
    "5": ANGLE_5,
    "6": ANGLE_6,
    "7": ANGLE_7,
    "8": ANGLE_8,
}

MAX_TENTATIVES = 3

_SEPARATEUR_SECTION_RE = re.compile(r"^\s*-{3,}\s*$", re.MULTILINE)


def decouper_script_en_sections(script: str) -> list:
    """Découpe le script en sections, chaque section étant un bloc de texte
    séparé par '---'. Retourne la liste des sections (texte brut, dans l'ordre),
    en ignorant les blocs vides.
    """
    sections = _SEPARATEUR_SECTION_RE.split(script)
    return [section.strip() for section in sections if section.strip()]


def demander_choix(prompt: str, options: dict) -> str:
    while True:
        choix = input(prompt).strip()
        if choix in options:
            return choix
        print(f"Choix invalide. Options possibles : {', '.join(options)}")


def main() -> None:
    if not ffmpeg_disponible():
        print("FFmpeg n'est pas installé. ")
        print("Télécharge-le sur https://ffmpeg.org/download.html")
        print("et ajoute-le au PATH de ton système.")
        sys.exit(1)

    print("============================================")
    print("        PRÉDICTA — AGENT CONTENU")
    print("============================================")
    print("Bienvenue. Cet agent génère des scripts")
    print("vidéo prêts à publier pour Prédicta.")
    print("============================================")

    print("\nChoisis une plateforme :")
    print("1. YouTube (8-10 minutes)")
    print("2. TikTok (60 secondes)")
    print("3. Instagram / Facebook (2-3 minutes)")
    choix_plateforme = demander_choix("Ton choix (1, 2 ou 3) : ", PLATEFORMES)
    label_plateforme, plateforme = PLATEFORMES[choix_plateforme]

    print("\nChoisis un angle :")
    print("1. Détruire une croyance populaire")
    print("2. Mettre un nom sur une expérience universelle")
    print("3. Transformer un comportement banal en mystère")
    print("4. Parler d'un paradoxe")
    print("5. La révélation scientifique")
    print("6. Le retournement de culpabilité")
    print("7. La comparaison inattendue")
    print("8. Le tu n'es pas seul")
    choix_angle = demander_choix("Ton choix (1 à 8) : ", ANGLES)
    angle = ANGLES[choix_angle]

    print("\nChoisis ton sujet :")
    print("1. Laisser l'agent trouver le sujet automatiquement")
    print("2. Entrer mon propre sujet manuellement")
    choix_sujet = demander_choix("Ton choix (1 ou 2) : ", {"1": None, "2": None})

    if choix_sujet == "1":
        sujet = generate_subject(angle, plateforme)
    else:
        sujet = input("Décris ton sujet en une phrase : ").strip()

    print("\nGénération de l'idée en cours...")

    idee = None
    for tentative in range(1, MAX_TENTATIVES + 1):
        idee_candidate = generate_idea(angle, plateforme, sujet)
        verdict = filter_idea(idee_candidate)

        if verdict.strip().upper().startswith("VALIDÉE"):
            idee = idee_candidate
            break

        if tentative < MAX_TENTATIVES:
            print("L'idée générée ne provoque pas assez d'émotion.")
            print("Nouvelle tentative automatique...")

    if idee is None:
        print("L'agent n'a pas réussi à générer une idée assez forte.")
        print("Relance run.py et essaie un autre angle.")
        sys.exit(1)

    print("\nIdée validée. Génération du script complet...")
    script = generate_script(idee, plateforme)

    print(script)

    os.makedirs("scripts", exist_ok=True)
    horodatage = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    nom_fichier = f"{label_plateforme}_{horodatage}.txt"
    chemin_fichier = os.path.join("scripts", nom_fichier)

    with open(chemin_fichier, "w", encoding="utf-8") as f:
        f.write(script)

    print("============================================")
    print(f"Script sauvegardé dans scripts/{nom_fichier}")
    print("============================================")

    print("Découpage du script en sections...")
    sections = decouper_script_en_sections(script)

    print("Génération de la voix en cours...")
    nom_fichier_audio = f"{label_plateforme}_{horodatage}.mp3"
    chemin_audio, durees_sections = generate_voice_per_section(sections, nom_fichier_audio)
    print(f"Audio sauvegardé dans audio/{nom_fichier_audio}")
    print("============================================")

    dossier_temp_videos = f"temp_videos_{horodatage}"
    dossier_temp_normalise = f"temp_normalized_{horodatage}"
    nom_fichier_video = f"{label_plateforme}_{horodatage}.mp4"
    chemin_video = os.path.join("videos", nom_fichier_video)

    try:
        print("Recherche de visuels africains en cours...")
        mots_cles = extract_keywords_per_section(sections)
        chemins_videos = download_videos(mots_cles, dossier_temp_videos)

        print("Montage de la vidéo en cours...")
        assemble_video(
            chemins_videos,
            chemin_audio,
            chemin_video,
            label_plateforme,
            durees_sections,
            dossier_temp_normalise,
        )
    finally:
        shutil.rmtree(dossier_temp_videos, ignore_errors=True)
        shutil.rmtree(dossier_temp_normalise, ignore_errors=True)

    print("Ajout des sous-titres en cours...")
    generate_subtitles(script, chemin_audio, chemin_video, chemin_video, label_plateforme)
    print(f"Vidéo finale avec sous-titres sauvegardée dans videos/{nom_fichier_video}")
    print("============================================")


if __name__ == "__main__":
    main()
