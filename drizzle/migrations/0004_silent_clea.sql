CREATE TABLE "label_image_blobs" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"original_filename" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
