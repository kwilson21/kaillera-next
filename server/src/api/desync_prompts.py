"""Per-field prompt templates for the desync vision endpoint.

Each template instructs Claude to look at ONE specific aspect of the
two screenshots and return strict JSON. Keep prompts narrow and
unambiguous — the broader the prompt, the noisier the verdict."""

PROMPT_BY_FIELD = {
    "damage": """These two screenshots are from peers A and B at the same game frame.
Look ONLY at player {slot}'s damage percentage in the bottom HUD (large yellow
number with a % sign). Return strict JSON:
{{"a_damage": <int>, "b_damage": <int>, "equal": <bool>, "confidence": "high"|"med"|"low"}}
Confidence is "low" if the HUD is occluded or transitioning.""",
    "stocks": """These two screenshots are from peers A and B at the same game frame.
Look ONLY at player {slot}'s stock count (the small character icons in the bottom
panel — count them). Return strict JSON:
{{"a_stocks": <int>, "b_stocks": <int>, "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",
    "character_id": """Peers A and B at the same game frame. Look ONLY at the character
selected for player {slot} (in CSS) or the character on screen for player {slot}
(in-game). Return strict JSON:
{{"a_character": "<name>", "b_character": "<name>", "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",
    "css_cursor": """Peers A and B during character select. Look ONLY at where player
{slot}'s cursor is positioned on the character grid. Return strict JSON:
{{"a_cursor": "<character-name-cursor-is-on-or-position-description>", "b_cursor": "<...>", "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",
    # v1 prompt — physics_motion is keyed off the global gFTManagerMotionCount
    # counter, not per-player struct hashing. v2 will refine to per-player.
    "physics_motion": """Peers A and B at the same game frame. Look at all visible
fighters' positions and animations. Return strict JSON:
{{"differences": ["<short description>", ...], "equal": <bool>, "confidence": "high"|"med"|"low"}}.
Empty differences array if everything matches.""",
    "match_phase": """Peers A and B. Identify what screen each is showing
(menu, character select, stage select, in-game, results). Return strict JSON:
{{"a_phase": "<name>", "b_phase": "<name>", "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",
    "heartbeat": """Peers A and B at the same game frame. Compare overall game state
visually. Return strict JSON:
{{"differences": ["<short description>", ...], "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",
}

# Fields that don't have a unique vision counterpart get the heartbeat-style prompt.
PROMPT_BY_FIELD["rng"] = PROMPT_BY_FIELD["heartbeat"]
PROMPT_BY_FIELD["vs_battle_hdr"] = PROMPT_BY_FIELD["heartbeat"]
PROMPT_BY_FIELD["css_selected"] = PROMPT_BY_FIELD["css_cursor"]
# ft_buffer is a hash over the full FTStruct alloc buffer — covers per-fighter
# damage, position, velocity, action_state across all 4 players in one signal.
# Vision still gets the full screenshot to identify which player diverged.
PROMPT_BY_FIELD["ft_buffer"] = PROMPT_BY_FIELD["physics_motion"]


def render(field: str, slot: int | None) -> str:
    template = PROMPT_BY_FIELD.get(field, PROMPT_BY_FIELD["heartbeat"])
    return template.format(slot=slot if slot is not None else 0)
