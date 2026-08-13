ALTER TABLE "review_queue" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "review_queue" ALTER COLUMN "created_at" SET DEFAULT now();