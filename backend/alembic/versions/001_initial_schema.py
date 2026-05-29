"""Schema inicial — tabelas snapshots e alert_settings

Revision ID: 001
Revises:
Create Date: 2026-05-23
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = inspector.get_table_names()

    # ── snapshots ─────────────────────────────────────────────────────────
    if "snapshots" not in existing_tables:
        op.create_table(
            "snapshots",
            sa.Column("id",           sa.Integer(),    primary_key=True, index=True),
            sa.Column("timestamp",    sa.DateTime(),   nullable=False),
            sa.Column("mode",         sa.String(10),   nullable=False, server_default="full"),
            sa.Column("queue_total",  sa.Integer(),    nullable=False, server_default="0"),
            sa.Column("severity",     sa.String(20),   nullable=False, server_default="OK"),
            sa.Column("problem",      sa.String(40),   nullable=False, server_default="NORMAL"),
            sa.Column("delivered",    sa.Integer(),    nullable=False, server_default="0"),
            sa.Column("rejected",     sa.Integer(),    nullable=False, server_default="0"),
            sa.Column("deferred",     sa.Integer(),    nullable=False, server_default="0"),
            sa.Column("recent_sends", sa.Integer(),    nullable=False, server_default="0"),
            sa.Column("data",         postgresql.JSONB(), nullable=True),
        )
        op.create_index("ix_snapshots_ts_brin",   "snapshots", ["timestamp"],         postgresql_using="brin")
        op.create_index("ix_snapshots_mode_ts",   "snapshots", ["mode", "timestamp"])
        op.create_index("ix_snapshots_severity",  "snapshots", ["severity"])

    # ── alert_settings ────────────────────────────────────────────────────
    if "alert_settings" not in existing_tables:
        op.create_table(
            "alert_settings",
            sa.Column("id",                 sa.Integer(),    primary_key=True),
            sa.Column("email_enabled",      sa.Boolean(),    nullable=False, server_default="false"),
            sa.Column("email_to",           sa.String(255),  nullable=False, server_default=""),
            sa.Column("smtp_host",          sa.String(255),  nullable=False, server_default="smtp.sendgrid.net"),
            sa.Column("smtp_port",          sa.Integer(),    nullable=False, server_default="587"),
            sa.Column("smtp_user",          sa.String(255),  nullable=False, server_default="apikey"),
            sa.Column("smtp_password",      sa.String(500),  nullable=False, server_default=""),
            sa.Column("smtp_from",          sa.String(255),  nullable=False, server_default="alertas@exim-monitor.io"),
            sa.Column("smtp_tls",           sa.Boolean(),    nullable=False, server_default="true"),
            sa.Column("resend_api_key",     sa.String(500),  nullable=False, server_default=""),
            sa.Column("telegram_enabled",   sa.Boolean(),    nullable=False, server_default="false"),
            sa.Column("telegram_bot_token", sa.String(500),  nullable=False, server_default=""),
            sa.Column("telegram_chat_id",   sa.String(100),  nullable=False, server_default=""),
            sa.Column("severity_threshold", sa.String(20),   nullable=False, server_default="HIGH"),
            sa.Column("queue_threshold",    sa.Integer(),    nullable=False, server_default="0"),
            sa.Column("cooldown_minutes",   sa.Integer(),    nullable=False, server_default="30"),
        )


def downgrade() -> None:
    op.drop_table("alert_settings")
    op.drop_index("ix_snapshots_severity", table_name="snapshots")
    op.drop_index("ix_snapshots_mode_ts",  table_name="snapshots")
    op.drop_index("ix_snapshots_ts_brin",  table_name="snapshots")
    op.drop_table("snapshots")
