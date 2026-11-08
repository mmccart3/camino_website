# camino/stage_names.py
"""Stage names as the pages show them.

The guide's database sometimes writes a stage's number into its name as well ("16b: Frómista to Carrión de los
Condes (river route)" for the stage numbered 16b). The pages already print "Stage 16b:" in front of the name, so
the number would appear twice. Every part of the site that reads a stage name from the database passes it through
clean_stage_name(), so a name is the same wherever it is shown, searched or translated: the Spanish text in
camino/locale/es.json is filed under the cleaned name.

This module uses nothing but the standard library, so the planner (which reads the database with plain SQL) can use it.
"""
import re


def clean_stage_name(name, display_ref):
    """The name without a leading "<its own number>: ", or unchanged when it has none.

    Only a prefix that repeats this stage's own display number is removed ("16b: " on stage 16b), never any other
    text, and a name that would be left empty is kept as it was.
    """
    text = '' if name is None else str(name)
    ref = '' if display_ref is None else str(display_ref).strip()
    if not ref:
        return name
    cleaned = re.sub(r'^\s*' + re.escape(ref) + r'\s*:\s*', '', text, count=1, flags=re.IGNORECASE)
    return cleaned if cleaned.strip() else name
