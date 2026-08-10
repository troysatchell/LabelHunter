CREATE TYPE "public"."batch_job_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."beverage_type" AS ENUM('beer', 'wine', 'spirits');--> statement-breakpoint
CREATE TYPE "public"."field_name" AS ENUM('BRAND_NAME', 'CLASS_TYPE', 'ALCOHOL_CONTENT', 'NET_CONTENTS', 'GOVERNMENT_WARNING');--> statement-breakpoint
CREATE TYPE "public"."field_verdict" AS ENUM('MATCH', 'MISMATCH', 'NEEDS_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."label_verdict" AS ENUM('PASS', 'FAIL', 'REVIEW');--> statement-breakpoint
CREATE TYPE "public"."resolution_path" AS ENUM('EXTRACTOR_ONLY', 'EXTRACTOR_RESOLVER');--> statement-breakpoint
CREATE TYPE "public"."review_disposition" AS ENUM('APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."review_reason" AS ENUM('LOW_IMAGE_QUALITY', 'AMBIGUOUS_BRAND', 'AMBIGUOUS_ABV', 'AMBIGUOUS_NET_CONTENTS', 'WARNING_MISMATCH', 'MISSING_REQUIRED_FIELD', 'CONFLICTING_EXTRACTION', 'LOW_MODEL_CONFIDENCE');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "applications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"batch_job_id" integer,
	"beverage_type" "beverage_type" NOT NULL,
	"brand_name" text NOT NULL,
	"class_type" text NOT NULL,
	"alcohol_content_raw" text,
	"abv_percent" numeric(5, 2),
	"proof" numeric(5, 2),
	"net_contents_raw" text,
	"net_contents_value" numeric(10, 3),
	"net_contents_unit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batch_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"status" "batch_job_status" DEFAULT 'PENDING' NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"auto_verified_count" integer DEFAULT 0 NOT NULL,
	"resolved_by_sonnet_count" integer DEFAULT 0 NOT NULL,
	"needs_human_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_jobs_total_count_non_negative" CHECK ("batch_jobs"."total_count" >= 0),
	CONSTRAINT "batch_jobs_processed_count_bounded" CHECK ("batch_jobs"."processed_count" >= 0 AND "batch_jobs"."processed_count" <= "batch_jobs"."total_count"),
	CONSTRAINT "batch_jobs_auto_verified_count_bounded" CHECK ("batch_jobs"."auto_verified_count" >= 0 AND "batch_jobs"."auto_verified_count" <= "batch_jobs"."total_count"),
	CONSTRAINT "batch_jobs_resolved_by_sonnet_count_bounded" CHECK ("batch_jobs"."resolved_by_sonnet_count" >= 0 AND "batch_jobs"."resolved_by_sonnet_count" <= "batch_jobs"."total_count"),
	CONSTRAINT "batch_jobs_needs_human_count_bounded" CHECK ("batch_jobs"."needs_human_count" >= 0 AND "batch_jobs"."needs_human_count" <= "batch_jobs"."total_count"),
	CONSTRAINT "batch_jobs_failed_count_bounded" CHECK ("batch_jobs"."failed_count" >= 0 AND "batch_jobs"."failed_count" <= "batch_jobs"."total_count")
);
--> statement-breakpoint
CREATE TABLE "field_results" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "field_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"verification_id" integer NOT NULL,
	"field_name" "field_name" NOT NULL,
	"extracted_value" text,
	"evidence" text NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"verdict" "field_verdict" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_results_confidence_range" CHECK ("field_results"."confidence" >= 0 AND "field_results"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "label_images" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "label_images_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"application_id" integer,
	"batch_job_id" integer,
	"storage_path" text NOT NULL,
	"original_filename" text NOT NULL,
	"width_px" integer NOT NULL,
	"height_px" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_images_belongs_to_something" CHECK ("label_images"."application_id" IS NOT NULL OR "label_images"."batch_job_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_queue_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"verification_id" integer NOT NULL,
	"reason" "review_reason" NOT NULL,
	"resolver_output" jsonb,
	"disposition" "review_disposition",
	"disposed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_queue_disposition_disposed_at_consistency" CHECK (("review_queue"."disposition" IS NULL) = ("review_queue"."disposed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"application_id" integer NOT NULL,
	"label_image_id" integer NOT NULL,
	"batch_job_id" integer,
	"verdict" "label_verdict" NOT NULL,
	"resolution_path" "resolution_path" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_batch_job_id_batch_jobs_id_fk" FOREIGN KEY ("batch_job_id") REFERENCES "public"."batch_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_results" ADD CONSTRAINT "field_results_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_images" ADD CONSTRAINT "label_images_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_images" ADD CONSTRAINT "label_images_batch_job_id_batch_jobs_id_fk" FOREIGN KEY ("batch_job_id") REFERENCES "public"."batch_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_label_image_id_label_images_id_fk" FOREIGN KEY ("label_image_id") REFERENCES "public"."label_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_batch_job_id_batch_jobs_id_fk" FOREIGN KEY ("batch_job_id") REFERENCES "public"."batch_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_batch_job_id_idx" ON "applications" USING btree ("batch_job_id");--> statement-breakpoint
CREATE INDEX "batch_jobs_status_idx" ON "batch_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "field_results_verification_field_unique" ON "field_results" USING btree ("verification_id","field_name");--> statement-breakpoint
CREATE INDEX "label_images_application_id_idx" ON "label_images" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "label_images_batch_job_id_idx" ON "label_images" USING btree ("batch_job_id");--> statement-breakpoint
CREATE INDEX "label_images_batch_filename_idx" ON "label_images" USING btree ("batch_job_id","original_filename");--> statement-breakpoint
CREATE UNIQUE INDEX "review_queue_verification_id_unique" ON "review_queue" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "review_queue_reason_idx" ON "review_queue" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "review_queue_unresolved_idx" ON "review_queue" USING btree ("created_at") WHERE "review_queue"."disposition" IS NULL;--> statement-breakpoint
CREATE INDEX "verifications_application_id_idx" ON "verifications" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "verifications_label_image_id_idx" ON "verifications" USING btree ("label_image_id");--> statement-breakpoint
CREATE INDEX "verifications_batch_job_id_idx" ON "verifications" USING btree ("batch_job_id");--> statement-breakpoint
CREATE INDEX "verifications_verdict_idx" ON "verifications" USING btree ("verdict");