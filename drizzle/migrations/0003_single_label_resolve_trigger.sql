ALTER TABLE "review_queue" ADD COLUMN "resolver_input" jsonb;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "review_queue_pending_resolve_idx" ON "review_queue" USING btree ("available_at") WHERE "review_queue"."resolver_output" IS NULL AND "review_queue"."resolver_skip_reason" IS NULL AND "review_queue"."resolver_input" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_attempts_non_negative" CHECK ("review_queue"."attempts" >= 0);