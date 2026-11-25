# Service Desk

Milestones 1–2 of a mobile-first vehicle service tracker for one advisor at one showroom. Built with React, TypeScript, Vite, Supabase Auth, Supabase Postgres, and private Supabase Storage for signed handovers.

## Set up locally

1. Use Node.js 20.19+ or 22.12+ and install dependencies with `npm install`.
2. Create a Supabase project, then apply both SQL migrations in filename order from `supabase/migrations` using the Supabase SQL editor or Supabase CLI.
3. Configure Supabase Auth email/password sign-in and your local site URL. Email confirmation may be enabled; when enabled, confirm the signup email before signing in.
4. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the project URL and publishable/anon key. Never use a service-role key in the browser.
5. Run `npm run dev`, then open the local URL. For phone testing, run `npm run dev -- --host 0.0.0.0`, open the computer's LAN IP and Vite port on the phone on the same Wi-Fi, allow the port through the local firewall, and add that LAN origin to Supabase Auth's allowed redirect URLs.

`npm run build` type-checks and builds the production frontend.

## Service workflow

- Sign up and sign in with Supabase email/password authentication.
- Search vehicles by registration, add missing vehicles during check-in, and open a separate job for each visit.
- For a registration with a previous visit, prefill the owner name and WhatsApp number from the latest job; both remain editable and are saved on the new job.
- Warn before creating a visit if that vehicle has a job in Checked in, In service, On hold, or Ready for pickup. The advisor can confirm a separate return visit.
- Keep each job's owner name and WhatsApp number, odometer, requested work, optional promised pickup time, and service notes.
- Record Checked in, In service, On hold, and Ready for pickup in status history. On hold and returning a ready job to service require a reason. The database trigger records the authenticated advisor and timestamp and rejects invalid transitions.
- Capture a photo with the phone camera or import images. Full images and generated thumbnails stay in IndexedDB and are keyed by both advisor ID and job ID; photos and their metadata are not sent to Supabase.
- Prepare an editable WhatsApp message containing the registration and job reference. Opening WhatsApp does not change the job status or record a sent message.
- A ready job may return to In service with a reason. To hand over a vehicle, the advisor opens **Complete handover**, reviews the job, records the owner or authorized pickup person's name, and hands the phone over for signature. The signer acknowledges receipt; the advisor saves the signed handover.
- The signature image and generated PDF are stored in a private Supabase Storage bucket. RLS restricts file access to the advisor who owns the job. The database only allows a job to enter **Handed over** through the handover RPC after the signature and PDF have been uploaded and a signed handover record has been created.
- The signed PDF can be reopened from the handed-over job card through a short-lived signed URL. Job status history records the advisor and time of handover.

## Phone verification checklist

1. Check in a new registration. Confirm the job appears as Checked in with the contact, odometer, requested work, notes, and pickup time in its job card.
2. Open the job, take a camera photo and import an image. Refresh the browser and reopen the same job; its thumbnails should remain. Sign in as a different advisor or open another job; those photos should not appear there. Photos are browser/device-local and are not backed up to Supabase.
3. Search the same registration after check-in. Confirm the open-job warning points to the existing visit. After the first job reaches Ready for pickup, create a new visit for that registration and confirm it gets a new job reference and independent history.
4. Mark a job Ready for pickup, tap WhatsApp owner, edit the draft, and open WhatsApp. Confirm the registration and job reference are in the editable draft, and return to Service Desk: the job remains Ready for pickup.
5. On a ready job, tap **Complete handover**, verify the vehicle and job summary with the customer, select owner or authorized pickup person, enter the collector's name, and sign on the phone. Confirm the acknowledgement and save. Check that the job becomes Handed over, the status history is updated, and **View signed PDF** opens the receipt. Confirm that a job cannot be marked Handed over without a signature.

## Data access

RLS policies scope vehicles, jobs, status history, handover records, and private handover files to `auth.uid()`. Database triggers validate status transitions and write status history. A transactional database function requires a recorded handover before permitting the Handed over status. The browser only needs the Supabase URL and anon/publishable key.
