"""Générateur de voix pour Prédicta via Edge TTS."""

import asyncio
import os
import re
import subprocess
import sys

try:
    import edge_tts
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "edge-tts"])
    import edge_tts

VOICE = "fr-FR-HenriNeural"  # voix masculine française, naturelle et gratuite

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


def _nettoyer_script(script_text: str) -> str:
    """Ne garde que le texte pur destiné à être lu à voix haute."""
    lignes_utiles = []

    for ligne in script_text.splitlines():
        ligne_stripped = ligne.strip()

        if _NOTES_REALISATION_RE.match(ligne_stripped):
            break  # tout ce qui suit les notes de réalisation est ignoré

        if not ligne_stripped:
            lignes_utiles.append("")
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

    texte = "\n".join(lignes_utiles)
    texte = _GRAS_RE.sub(r"\1", texte)
    texte = _ITALIQUE_RE.sub(r"\1", texte)
    texte = _PREDICTA_MAJ_RE.sub("Prédicta", texte)
    texte = re.sub(r"\benjeux hauts\b", "enjeux-hauts", texte, flags=re.IGNORECASE)
    texte = re.sub(r"\n{3,}", "\n\n", texte)  # une seule pause entre les paragraphes

    # Edge TTS marque une longue pause à chaque retour à la ligne : on aplatit
    # le texte sur une seule ligne continue pour réduire les silences entre phrases.
    texte = re.sub(r"\.\n", ". ", texte)
    texte = texte.replace("\n\n", " ")
    texte = re.sub(r"\n+", " ", texte)
    texte = re.sub(r" {2,}", " ", texte)

    return texte.strip()


async def _synthetiser(texte: str, chemin_audio: str) -> None:
    communicate = edge_tts.Communicate(texte, VOICE, rate="+10%")
    await communicate.save(chemin_audio)


def generate_voice(script_text: str, output_filename: str) -> str:
    """Génère un fichier audio MP3 à partir d'un script texte via Edge TTS."""
    os.makedirs("audio", exist_ok=True)

    texte_propre = _nettoyer_script(script_text)
    chemin_audio = os.path.join("audio", output_filename)

    asyncio.run(_synthetiser(texte_propre, chemin_audio))

    return chemin_audio
