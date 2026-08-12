CREATE TYPE "public"."batch_queue_item_kind" AS ENUM('EXTRACT', 'RESOLVE');--> statement-breakpoint
CREATE TYPE "public"."batch_queue_item_status" AS ENUM('PENDING', 'CLAIMED', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TABLE "batch_queue_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batch_queue_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"batch_job_id" integer NOT NULL,
	"kind" "batch_queue_item_kind" NOT NULL,
	"application_id" integer,
	"label_image_id" integer,
	"verification_id" integer,
	"resolver_input" jsonb,
	"status" "batch_queue_item_status" DEFAULT 'PENDING' NOT NULL,
	"claimed_by" text,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_queue_items_kind_shape" CHECK ((
        ("batch_queue_items"."kind" = 'EXTRACT' AND "batch_queue_items"."application_id" IS NOT NULL AND "batch_queue_items"."label_image_id" IS NOT NULL
          AND "batch_queue_items"."verification_id" IS NULL AND "batch_queue_items"."resolver_input" IS NULL)
        OR
        ("batch_queue_items"."kind" = 'RESOLVE' AND "batch_queue_items"."verification_id" IS NOT NULL AND "batch_queue_items"."resolver_input" IS NOT NULL
          AND "batch_queue_items"."application_id" IS NULL AND "batch_queue_items"."label_image_id" IS NULL)
      )),
	CONSTRAINT "batch_queue_items_attempts_non_negative" CHECK ("batch_queue_items"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "batch_jobs" ADD COLUMN "sonnet_call_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "resolver_skip_reason" text;--> statement-breakpoint
ALTER TABLE "batch_queue_items" ADD CONSTRAINT "batch_queue_items_batch_job_id_batch_jobs_id_fk" FOREIGN KEY ("batch_job_id") REFERENCES "public"."batch_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_queue_items" ADD CONSTRAINT "batch_queue_items_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_queue_items" ADD CONSTRAINT "batch_queue_items_label_image_id_label_images_id_fk" FOREIGN KEY ("label_image_id") REFERENCES "public"."label_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_queue_items" ADD CONSTRAINT "batch_queue_items_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_queue_items_claim_idx" ON "batch_queue_items" USING btree ("kind","status","available_at") WHERE "batch_queue_items"."status" IN ('PENDING', 'CLAIMED');--> statement-breakpoint
CREATE INDEX "batch_queue_items_batch_job_id_idx" ON "batch_queue_items" USING btree ("batch_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_queue_items_extract_pairing_unique" ON "batch_queue_items" USING btree ("batch_job_id","application_id","label_image_id") WHERE "batch_queue_items"."kind" = 'EXTRACT';--> statement-breakpoint
CREATE UNIQUE INDEX "batch_queue_items_resolve_verification_unique" ON "batch_queue_items" USING btree ("verification_id") WHERE "batch_queue_items"."kind" = 'RESOLVE';--> statement-breakpoint
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_sonnet_call_count_bounded" CHECK ("batch_jobs"."sonnet_call_count" >= 0 AND "batch_jobs"."sonnet_call_count" <= "batch_jobs"."total_count");--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_resolver_output_skip_reason_exclusive" CHECK (NOT ("review_queue"."resolver_output" IS NOT NULL AND "review_queue"."resolver_skip_reason" IS NOT NULL));