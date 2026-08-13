CREATE TABLE "daily_spend" (
	"spend_date" date PRIMARY KEY NOT NULL,
	"total_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_spend_total_usd_non_negative" CHECK ("daily_spend"."total_usd" >= 0)
);
