"""Générateur de sous-titres pour Prédicta : incruste les sous-titres sur la vidéo finale via FFmpeg."""

import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    from pydub import AudioSegment
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pydub"])
    from pydub import AudioSegment

from voice_generator import _nettoyer_script

MOTS_MAX_PAR_SOUS_TITRE = 5

_PONCTUATION_RE = re.compile(r"[.,\n]+")

_STYLES_PLATEFORME = {
    "tiktok": {
        "largeur": 1080,
        "hauteur": 1920,
        "taille_police": 18,
        "couleur": "&H0000FFFF&",
        "contour": 3,
        "margin_v": 100,
    },
    "instagram": {
        "largeur": 1080,
        "hauteur": 1080,
        "taille_police": 18,
        "couleur": "&H0000FFFF&",
        "contour": 3,
        "margin_v": 60,
    },
    "facebook": {
        "largeur": 1080,
        "hauteur": 1080,
        "taille_police": 18,
        "couleur": "&H0000FFFF&",
        "contour": 3,
        "margin_v": 60,
    },
    "youtube": {
        "largeur": 1920,
        "hauteur": 1080,
        "taille_police": 14,
        "couleur": "&H00FFFFFF&",
        "contour": 2,
        "margin_v": 50,
    },
}


def _decouper_en_sous_titres(script_text: str) -> list:
    """Découpe le script en groupes de mots courts (5 mots maximum par sous-titre).

    Réutilise le nettoyage de voice_generator (retrait des titres markdown, des
    notes de réalisation et des balises entre crochets) pour que les sous-titres
    n'affichent que le texte réellement prononcé dans la voix off, puis coupe
    sur la ponctuation (points, virgules, retours à la ligne) avant de regrouper
    les mots par blocs de 5 maximum.
    """
    texte_propre = " ".join(_nettoyer_script(script_text))
    segments = [s.strip() for s in _PONCTUATION_RE.split(texte_propre) if s.strip()]

    sous_titres = []
    for segment in segments:
        mots = segment.split()
        for i in range(0, len(mots), MOTS_MAX_PAR_SOUS_TITRE):
            sous_titres.append(" ".join(mots[i : i + MOTS_MAX_PAR_SOUS_TITRE]))

    return sous_titres


def _durees_par_sous_titre(sous_titres: list, duree_totale: float) -> list:
    """Répartit la durée totale de l'audio entre les sous-titres, au prorata
    du nombre de mots de chacun."""
    poids_sous_titres = [max(len(sous_titre.split()), 1) for sous_titre in sous_titres]
    poids_total = sum(poids_sous_titres)
    return [duree_totale * poids / poids_total for poids in poids_sous_titres]


def _formater_temps_ass(secondes: float) -> str:
    """Convertit une durée en secondes en timecode ASS (H:MM:SS.cc)."""
    total_centiemes = round(secondes * 100)
    heures, reste = divmod(total_centiemes, 360000)
    minutes, reste = divmod(reste, 6000)
    secs, centiemes = divmod(reste, 100)
    return f"{heures}:{minutes:02d}:{secs:02d}.{centiemes:02d}"


def _generer_fichier_ass(sous_titres: list, durees: list, style: dict, chemin_ass: str) -> None:
    """Écrit un fichier .ass avec un style adapté à la plateforme : un
    Dialogue par sous-titre, calé sur les durées fournies."""
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
        f"Style: Default,Arial,{style['taille_police']},{style['couleur']},&H000000FF&,"
        f"&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,{style['contour']},0,2,10,10,"
        f"{style['margin_v']},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lignes_dialogue = []
    instant = 0.0
    for sous_titre, duree in zip(sous_titres, durees):
        debut = _formater_temps_ass(instant)
        fin = _formater_temps_ass(instant + duree)
        lignes_dialogue.append(f"Dialogue: 0,{debut},{fin},Default,,0,0,0,,{sous_titre}")
        instant += duree

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
    script_text: str, audio_file: str, video_file: str, output_file: str, platform: str
) -> str:
    """Incruste des sous-titres automatiques sur la vidéo finale.

    Découpe `script_text` en groupes de 5 mots maximum, répartit chaque groupe
    sur la durée totale de `audio_file` au prorata du nombre de mots, génère un
    fichier .ass stylé selon `platform` (jaune/gras/contour épais pour TikTok
    et Instagram, blanc/contour plus fin pour YouTube) puis l'incruste sur
    `video_file` via le filtre FFmpeg `subtitles`. Le résultat est écrit dans
    `output_file` — si `output_file` est le même chemin que `video_file`, la
    vidéo sans sous-titres est remplacée par la version sous-titrée.
    """
    plateforme_normalisee = platform.lower()
    style = _STYLES_PLATEFORME.get(plateforme_normalisee, _STYLES_PLATEFORME["youtube"])

    duree_totale = len(AudioSegment.from_file(audio_file)) / 1000.0

    sous_titres = _decouper_en_sous_titres(script_text)
    if not sous_titres:
        raise ValueError("Aucun sous-titre à générer : le script est vide une fois nettoyé.")

    durees = _durees_par_sous_titre(sous_titres, duree_totale)

    with tempfile.TemporaryDirectory() as dossier_temp:
        chemin_ass = os.path.join(dossier_temp, "sous_titres.ass")
        _generer_fichier_ass(sous_titres, durees, style, chemin_ass)

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
