"""Moteur d'idées de l'agent Prédicta."""

import os
import subprocess
import sys
from pathlib import Path

try:
    import anthropic
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "anthropic"])
    import anthropic

try:
    from dotenv import load_dotenv
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-dotenv"])
    from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-sonnet-4-6"

MEMORY_PATH = Path(__file__).parent / "predicta_memory.md"
PREDICTA_MEMORY = MEMORY_PATH.read_text(encoding="utf-8")

# --- Angles de contenu ---

ANGLE_1 = "Détruire une croyance populaire"
ANGLE_2 = "Mettre un nom sur une expérience universelle"
ANGLE_3 = "Transformer un comportement banal en mystère"
ANGLE_4 = "Parler d'un paradoxe"
ANGLE_5 = "La révélation scientifique — prendre une étude réelle et montrer comment elle explique quelque chose que l'audience vit chaque jour"
ANGLE_6 = "Le retournement de culpabilité — prendre quelque chose dont les gens se blâment (paresse, manque de discipline) et montrer que c'est neurologique, pas moral"
ANGLE_7 = "La comparaison inattendue — comparer le cerveau à quelque chose de concret et inattendu"
ANGLE_8 = "Le tu n'es pas seul — décrire une expérience très précise et intime que personne n'ose dire à voix haute et montrer que c'est universelle"

ANGLES = [ANGLE_1, ANGLE_2, ANGLE_3, ANGLE_4, ANGLE_5, ANGLE_6, ANGLE_7, ANGLE_8]

# --- Plateformes ---

YOUTUBE = "YouTube — script 8 à 10 minutes, structure : accroche émotionnelle → vérité scientifique → histoire personnelle → transition vers Prédicta → CTA"
TIKTOK = "TikTok — script 60 secondes, accroche dans les 3 premières secondes, une seule idée, CTA final"
INSTAGRAM = "Instagram/Facebook — script 2 à 3 minutes, émotionnel, personnel, CTA vers liste d'attente Prédicta"

PLATEFORMES = [YOUTUBE, TIKTOK, INSTAGRAM]

# --- Sujets fréquents chez l'audience Prédicta ---

SUJETS = [
    "Je procrastine sans comprendre pourquoi",
    "Je commence des projets mais j'abandonne toujours",
    "Je me sens paresseux mais je sais que je suis capable de mieux",
    "Je suis motivé le matin et nul le soir",
    "Je culpabilise en boucle sans changer",
    "Je ne comprends pas pourquoi je change autant d'un jour à l'autre",
]

_client = anthropic.Anthropic()


def generate_subject(angle: str, plateforme: str) -> str:
    """Génère automatiquement un sujet réel et pertinent pour l'audience Prédicta."""
    response = _client.messages.create(
        model=MODEL,
        max_tokens=256,
        system=PREDICTA_MEMORY,
        messages=[
            {
                "role": "user",
                "content": (
                    "Génère un sujet pour un contenu Prédicta, adapté à cet angle "
                    f"et à cette plateforme.\n\n"
                    f"Angle : {angle}\n"
                    f"Plateforme : {plateforme}\n\n"
                    "Le sujet doit être une situation réelle, précise et concrète "
                    "vécue par l'audience de Prédicta (personnes ambitieuses qui "
                    "procrastinent, abandonnent, culpabilisent) — jamais générique, "
                    "jamais un thème abstrait. Formule-le comme l'audience le "
                    "dirait elle-même, en une phrase.\n\n"
                    "Retourne uniquement le sujet, sans introduction ni explication."
                ),
            }
        ],
    )
    return response.content[0].text.strip()


def generate_idea(angle: str, plateforme: str, sujet: str) -> str:
    """Génère une idée de contenu complète selon l'angle, la plateforme et le sujet."""
    response = _client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=PREDICTA_MEMORY,
        messages=[
            {
                "role": "user",
                "content": (
                    "Génère une idée de contenu complète pour Prédicta.\n\n"
                    f"Angle : {angle}\n"
                    f"Plateforme : {plateforme}\n"
                    f"Sujet de l'audience : {sujet}\n\n"
                    "L'idée doit inclure : un titre/accroche, le fil narratif "
                    "de l'idée, et pourquoi elle correspond à cet angle et à ce sujet."
                ),
            }
        ],
    )
    return response.content[0].text


def filter_idea(idee: str) -> str:
    """Filtre désactivé temporairement — valide toujours l'idée sans appeler l'API."""
    return "VALIDÉE — filtre désactivé temporairement."


def generate_script(idee_validee: str, plateforme: str) -> str:
    """Génère le script complet prêt à être lu devant la caméra."""
    if plateforme == YOUTUBE:
        structure = (
            "un script complet de 8 à 10 minutes structuré en 7 parties : "
            "accroche émotionnelle → histoire personnelle → vérité scientifique → "
            "ce que la plupart des gens font → ce qui marche vraiment → "
            "transition vers Prédicta → conclusion et CTA"
        )
    elif plateforme == TIKTOK:
        structure = (
            "un script de 60 secondes avec une accroche dans les 3 premières "
            "secondes, une seule idée forte, et un CTA final"
        )
    else:
        structure = "un script de 2 à 3 minutes, émotionnel, personnel, avec un CTA vers la liste d'attente Prédicta"

    response = _client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=PREDICTA_MEMORY,
        messages=[
            {
                "role": "user",
                "content": (
                    "À partir de cette idée validée :\n\n"
                    f"{idee_validee}\n\n"
                    f"Génère {structure}.\n\n"
                    "Le script doit provoquer au moins une de ces émotions : "
                    '"Je me reconnais complètement", "Je n\'avais jamais pensé à ça", '
                    '"Donc je ne suis pas paresseux ?".\n\n'
                    "Retourne le script complet, prêt à être lu devant la caméra."
                ),
            }
        ],
    )
    return response.content[0].text


if __name__ == "__main__":
    idee = generate_idea(ANGLE_6, YOUTUBE, SUJETS[0])
    print("=== IDÉE ===")
    print(idee)

    verdict = filter_idea(idee)
    print("\n=== FILTRE ===")
    print(verdict)

    if verdict.strip().startswith("VALIDÉE"):
        script = generate_script(idee, YOUTUBE)
        print("\n=== SCRIPT ===")
        print(script)
