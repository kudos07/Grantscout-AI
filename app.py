import json
from datetime import datetime

import pandas as pd
import streamlit as st

from grantscout.db import GrantScoutDB
from grantscout.pipeline import run_grantscout
from grantscout.schemas import UserProfile


st.set_page_config(page_title="GrantScout AI", page_icon="🔎", layout="wide")

st.title("GrantScout AI")
st.caption(
    "Agentic discovery + eligibility matching for grants, fellowships, scholarships, and startup credits."
)

with st.sidebar:
    st.header("User profile")
    profile_text = st.text_area(
        "Describe yourself",
        value=(
            "I am an international student in the US with a master’s in data science. "
            "I want AI, data science, research, nonprofit, or startup grants. I need free opportunities only."
        ),
        height=140,
    )
    location = st.text_input("Location (optional)", value="United States")
    citizenship = st.text_input("Citizenship / status (optional)", value="International student")
    interests = st.text_input(
        "Interests / keywords (comma-separated)", value="AI, data science, research, nonprofit, startup"
    )
    need_free_only = st.checkbox("Free opportunities only", value=True)
    min_results = st.number_input("Target opportunities", min_value=5, max_value=30, value=10)
    max_search_rounds = st.number_input("Max search rounds", min_value=1, max_value=10, value=5)
    run_btn = st.button("Run GrantScout", type="primary")

db = GrantScoutDB("grantscout.db")
db.init()

tab_run, tab_history = st.tabs(["Run", "History"])

with tab_run:
    st.subheader("Results")
    if run_btn:
        profile = UserProfile(
            free_only=need_free_only,
            narrative=profile_text.strip(),
            location=location.strip() or None,
            status=citizenship.strip() or None,
            interests=[s.strip() for s in interests.split(",") if s.strip()],
        )

        with st.spinner("Searching, reading official pages, extracting fields, validating eligibility..."):
            report = run_grantscout(
                profile=profile,
                min_results=int(min_results),
                max_search_rounds=int(max_search_rounds),
            )

        run_id = db.create_run(
            created_at=datetime.utcnow().isoformat(),
            profile_json=profile.model_dump_json(),
            report_json=json.dumps(report, ensure_ascii=False),
        )

        st.success(f"Saved run {run_id}.")

        opps = report.get("opportunities", [])
        if not opps:
            st.warning("No opportunities extracted yet. Try increasing search rounds or changing keywords.")
        else:
            df = pd.DataFrame(opps)
            preferred_cols = [
                "rank",
                "name",
                "eligibility_score",
                "deadline",
                "amount",
                "location",
                "type",
                "official_link",
                "application_link",
            ]
            cols = [c for c in preferred_cols if c in df.columns] + [c for c in df.columns if c not in preferred_cols]
            st.dataframe(df[cols], use_container_width=True, hide_index=True)

            st.divider()
            st.subheader("Application checklist")
            checklist = report.get("checklist", [])
            if checklist:
                for item in checklist:
                    st.checkbox(item, value=False, key=f"chk_{run_id}_{item}")
            else:
                st.write("No checklist generated.")

            st.subheader("Draft answers (short)")
            drafts = report.get("drafts", {})
            if drafts:
                for k, v in drafts.items():
                    st.markdown(f"**{k}**")
                    st.write(v)
            else:
                st.write("No drafts generated.")

            st.subheader("Export")
            st.download_button(
                "Download report JSON",
                data=json.dumps(report, indent=2, ensure_ascii=False),
                file_name="grantscout_report.json",
                mime="application/json",
            )

with tab_history:
    st.subheader("Saved runs")
    runs = db.list_runs(limit=25)
    if not runs:
        st.info("No runs saved yet.")
    else:
        runs_df = pd.DataFrame(runs)
        st.dataframe(runs_df, use_container_width=True, hide_index=True)

        chosen = st.selectbox(
            "Load a run",
            options=[r["id"] for r in runs],
            format_func=lambda rid: f"Run {rid}",
        )
        if chosen:
            record = db.get_run(int(chosen))
            report = json.loads(record["report_json"])
            st.json(report)
