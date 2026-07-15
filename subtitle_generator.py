"""Générateur de sous-titres pour Prédicta : incruste les sous-titres sur la vidéo finale via FFmpeg."""

import os
import re
import shutil
import subprocess
import tempfile

MOTS_PAR_GROUPE = 4
DUREE_MAX_SOUS_TITRE = 2.0  # secondes : aucun sous-titre ne reste plus longtemps à l'écran

_PONCTUATION_MOT_RE = re.compile(r"[^\wÀ-ÿ'-]", re.UNICODE)

_STYLES_PLATEFORME = {
    "tiktok": {
        "largeur": 1080,
        "hauteur": 1920,
        "taille_police": 18,
        "margin_v": 100,
    },
    "instagram": {
        "largeur": 1080,
        "hauteur": 1080,
        "taille_police": 18,
        "margin_v": 60,
    },
    "facebook": {
        "largeur": 1080,
        "hauteur": 1080,
        "taille_police": 18,
        "margin_v": 60,
    },
    "youtube": {
        "largeur": 1920,
        "hauteur": 1080,
        "taille_police": 14,
        "margin_v": 50,
    },
}

_COULEUR_JAUNE = "&H0000FFFF&"
_CONTOUR_EPAIS = 3


def _nettoyer_mot(mot: str) -> str:
    """Retire toute ponctuation résiduelle d'un mot (les sous-titres n'affichent
    que les mots, jamais de ponctuation visible)."""
    return _PONCTUATION_MOT_RE.sub("", mot).strip()


def _regrouper_mots(mots_avec_timing: list) -> list:
    """Regroupe les mots par lots de MOTS_PAR_GROUPE pour l'affichage.

    Chaque groupe apparaît exactement quand son premier mot est prononcé et
    disparaît à la fin du dernier mot du groupe — plafonné à DUREE_MAX_SOUS_TITRE
    secondes pour qu'aucun sous-titre ne reste trop longtemps à l'écran.
    """
    groupes = []

    for i in range(0, len(mots_avec_timing), MOTS_PAR_GROUPE):
        lot = mots_avec_timing[i : i + MOTS_PAR_GROUPE]
        mots_nettoyes = [_nettoyer_mot(mot["text"]) for mot in lot]
        mots_nettoyes = [mot for mot in mots_nettoyes if mot]
        if not mots_nettoyes:
            continue

        debut = lot[0]["debut"]
        fin_reelle = lot[-1]["debut"] + lot[-1]["duree"]
        fin = min(fin_reelle, debut + DUREE_MAX_SOUS_TITRE)

        groupes.append({"texte": " ".join(mots_nettoyes), "debut": debut, "fin": fin})

    return groupes


def _formater_temps_ass(secondes: float) -> str:
    """Convertit une durée en secondes en timecode ASS (H:MM:SS.cc)."""
    total_centiemes = round(secondes * 100)
    heures, reste = divmod(total_centiemes, 360000)
    minutes, reste = divmod(reste, 6000)
    secs, centiemes = divmod(reste, 100)
    return f"{heures}:{minutes:02d}:{secs:02d}.{centiemes:02d}"


def _generer_fichier_ass(groupes: list, style: dict, chemin_ass: str) -> None:
    """Écrit un fichier .ass avec un style adapté à la plateforme : un
    Dialogue par groupe de mots, calé sur son timing réel."""
    entete = (
        "[Script Info]\n"
        "Title: Sous-titres Prédicta\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {style['largeur']}\n"
        f"PlayResY: {style['hauteur']}\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Arial,{style['taille_police']},{_COULEUR_JAUNE},&H000000FF&,"
        f"&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,{_CONTOUR_EPAIS},0,2,10,10,"
        f"{style['margin_v']},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lignes_dialogue = []
    for groupe in groupes:
        debut = _formater_temps_ass(groupe["debut"])
        fin = _formater_temps_ass(groupe["fin"])
        lignes_dialogue.append(f"Dialogue: 0,{debut},{fin},Default,,0,0,0,,{groupe['texte']}")

    with open(chemin_ass, "w", encoding="utf-8") as f:
        f.write(entete)
        f.write("\n".join(lignes_dialogue))
        f.write("\n")


def _echapper_chemin_ffmpeg(chemin: str) -> str:
    """Échappe un chemin pour le filtre FFmpeg `subtitles` (les caractères ':'
    et '\\' ont un sens spécial dans le graphe de filtres)."""
    return chemin.replace("\\", "\\\\").replace(":", "\\:")


def _executer_ffmpeg(commande: list) -> None:
    print("Commande FFmpeg :")
    print(" ".join(commande))

    resultat = subprocess.run(commande, capture_output=True, text=True)

    if resultat.stderr:
        print(resultat.stderr)

    if resultat.returncode != 0:
        raise RuntimeError(f"Échec de la commande FFmpeg (code {resultat.returncode}).")


def generate_subtitles(
    mots_avec_timing: list, video_file: str, output_file: str, platform: str
) -> str:
    """Incruste des sous-titres automatiques sur la vidéo finale, synchronisés
    mot à mot sur la voix off réellement générée.

    `mots_avec_timing` est la liste des mots prononcés avec leur timing exact
    (texte, début, durée en secondes dans l'audio final), telle que renvoyée
    par voice_generator.generate_voice_per_section() — capturée en direct via
    les événements WordBoundary d'Edge TTS, pas estimée. Chaque sous-titre
    apparaît donc précisément quand ses mots sont prononcés, pas avant, pas
    après, et jamais plus de DUREE_MAX_SOUS_TITRE secondes à l'écran.

    Les mots sont regroupés par lots de MOTS_PAR_GROUPE, sans ponctuation
    visible, stylés selon `platform` (jaune gras, contour noir épais, bas de
    l'écran centré ; MAJUSCULES pour TikTok/Instagram/Facebook, minuscules
    pour YouTube) puis incrustés via le filtre FFmpeg `subtitles`. Le résultat
    est écrit dans `output_file` — si `output_file` est le même chemin que
    `video_file`, la vidéo sans sous-titres est remplacée par la version
    sous-titrée.
    """
    plateforme_normalisee = platform.lower()
    style = _STYLES_PLATEFORME.get(plateforme_normalisee, _STYLES_PLATEFORME["youtube"])
    majuscules = plateforme_normalisee != "youtube"

    groupes = _regrouper_mots(mots_avec_timing)
    if not groupes:
        raise ValueError("Aucun sous-titre à générer : aucun mot avec timing fourni.")

    for groupe in groupes:
        groupe["texte"] = groupe["texte"].upper() if majuscules else groupe["texte"].lower()

    with tempfile.TemporaryDirectory() as dossier_temp:
        chemin_ass = os.path.join(dossier_temp, "sous_titres.ass")
        _generer_fichier_ass(groupes, style, chemin_ass)

        chemin_video_sous_titree = os.path.join(dossier_temp, "video_sous_titree.mp4")
        _executer_ffmpeg([
            "ffmpeg",
            "-i", video_file,
            "-vf", f"subtitles={_echapper_chemin_ffmpeg(chemin_ass)}",
            "-c:a", "copy",
            "-y",
            chemin_video_sous_titree,
        ])

        dossier_sortie = os.path.dirname(output_file)
        if dossier_sortie:
            os.makedirs(dossier_sortie, exist_ok=True)

        shutil.move(chemin_video_sous_titree, output_file)

    return output_file
