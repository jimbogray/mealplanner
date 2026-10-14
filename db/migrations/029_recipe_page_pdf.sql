-- A PDF copy of each recipe's page, printed when it's added and kept in Azure Blob Storage in case the
-- site goes offline. The blob is named after the recipe; the PDF exists once page_pdf_saved_at is set.

ALTER TABLE favourite_recipe
    ADD COLUMN page_pdf_saved_at TIMESTAMPTZ,
    -- When printing it last failed, so a page that can't be printed isn't retried on every visit.
    ADD COLUMN page_pdf_failed_at TIMESTAMPTZ;
