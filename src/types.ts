export type JobStatus = "checked_in" | "in_service" | "on_hold" | "ready" | "handed_over";

export interface ServiceHandover {
  id: string;
  job_id: string;
  advisor_id: string;
  signer_name: string;
  signer_relationship: "owner" | "authorized_pickup";
  signed_at: string;
  signature_path: string;
  pdf_path: string;
}

export interface Vehicle {
  id: string;
  advisor_id: string;
  registration: string;
  make: string;
  model: string;
  created_at: string;
}

export interface StatusHistory {
  id: string;
  status: JobStatus;
  reason: string | null;
  changed_by: string;
  changed_at: string;
}

export interface ServiceJob {
  id: string;
  advisor_id: string;
  vehicle_id: string;
  job_ref: string;
  owner_name: string;
  whatsapp_number: string;
  odometer: number;
  requested_work: string;
  promised_pickup_at: string | null;
  service_notes: string;
  status: JobStatus;
  created_at: string;
  vehicles: Pick<Vehicle, "registration" | "make" | "model">;
  status_history: StatusHistory[];
  service_handovers?: ServiceHandover | null;
}
