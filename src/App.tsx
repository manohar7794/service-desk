import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Clock3,
  FileText,
  LogOut,
  MessageCircle,
  Plus,
  Search,
  ShieldCheck,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { deleteJobPhoto, listJobPhotos, saveJobPhoto } from "./lib/photos";
import type { JobPhoto } from "./lib/photos";
import { createId } from "./lib/id";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import HandoverModal from "./components/HandoverModal";
import type { JobStatus, ServiceHandover, ServiceJob, Vehicle } from "./types";

const STATUS_LABELS: Record<JobStatus, string> = {
  checked_in: "Checked in",
  in_service: "In service",
  on_hold: "On hold",
  ready: "Ready for pickup",
  handed_over: "Handed over",
};

const STATUS_ORDER: JobStatus[] = ["checked_in", "in_service", "on_hold", "ready", "handed_over"];
const OPEN_STATUSES: JobStatus[] = ["checked_in", "in_service", "on_hold", "ready"];

interface JobDraft {
  registration: string;
  make: string;
  model: string;
  ownerName: string;
  whatsappNumber: string;
  odometer: string;
  requestedWork: string;
  promisedPickupAt: string;
  serviceNotes: string;
}

const EMPTY_DRAFT: JobDraft = {
  registration: "",
  make: "",
  model: "",
  ownerName: "",
  whatsappNumber: "",
  odometer: "",
  requestedWork: "",
  promisedPickupAt: "",
  serviceNotes: "",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatPickup(value: string | null): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function makeJobRef(): string {
  const date = new Date();
  const day = `${date.getFullYear()}${`${date.getMonth() + 1}`.padStart(2, "0")}${`${date.getDate()}`.padStart(2, "0")}`;
  return `SV-${day}-${createId().replace(/-/g, "").slice(-8).toUpperCase()}`;
}

function nextStatuses(status: JobStatus): JobStatus[] {
  if (status === "checked_in") return ["in_service", "on_hold"];
  if (status === "in_service") return ["on_hold", "ready"];
  if (status === "on_hold") return ["in_service", "ready"];
  if (status === "ready") return ["in_service"];
  return [];
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [jobs, setJobs] = useState<ServiceJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [pageError, setPageError] = useState("");
  const [searchText, setSearchText] = useState("");
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<JobStatus | "all">("all");
  const [draft, setDraft] = useState<JobDraft>(EMPTY_DRAFT);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [jobFormOpen, setJobFormOpen] = useState(false);
  const [ownerDetailsPrefilled, setOwnerDetailsPrefilled] = useState(false);
  const [ownerDetailsEdited, setOwnerDetailsEdited] = useState(false);
  const [ownerPrefillError, setOwnerPrefillError] = useState("");
  const [creatingJob, setCreatingJob] = useState(false);
  const [pendingDuplicate, setPendingDuplicate] = useState<{ vehicleId: string; jobRef: string; status: JobStatus } | null>(null);
  const [activeJob, setActiveJob] = useState<ServiceJob | null>(null);
  const [handoverJob, setHandoverJob] = useState<ServiceJob | null>(null);
  const [statusChange, setStatusChange] = useState<{ job: ServiceJob; next: JobStatus } | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [whatsAppJob, setWhatsAppJob] = useState<ServiceJob | null>(null);
  const [whatsAppMessage, setWhatsAppMessage] = useState("");
  const [whatsAppError, setWhatsAppError] = useState("");
  const [photoList, setPhotoList] = useState<JobPhoto[]>([]);
  const [photoListJobId, setPhotoListJobId] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const user = session?.user ?? null;

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }
    let active = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setAuthError(error.message);
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthMessage("");
      setAuthError("");
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const loadJobs = useCallback(async () => {
    if (!user || !supabase) return;
    setLoadingJobs(true);
    setPageError("");
    try {
      const { data, error } = await supabase
        .from("service_jobs")
        .select("*, vehicles(registration, make, model), status_history(*), service_handovers(*)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const sorted = ((data ?? []) as ServiceJob[]).map((job) => ({
        ...job,
        status_history: [...(job.status_history ?? [])].sort(
          (a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime(),
        ),
      }));
      setJobs(sorted);
    } catch (error) {
      setPageError(messageOf(error));
    } finally {
      setLoadingJobs(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) void loadJobs();
    else {
      setJobs([]);
      setVehicles([]);
    }
  }, [user, loadJobs]);

  useEffect(() => {
    const client = supabase;
    if (!user || !client || searchText.trim().length < 2) {
      setVehicles([]);
      setSearching(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const { data, error } = await client
          .from("vehicles")
          .select("*")
          .ilike("registration", `%${searchText.trim()}%`)
          .order("registration")
          .limit(10);
        if (error) throw error;
        if (active) setVehicles((data ?? []) as Vehicle[]);
      } catch (error) {
        if (active) setPageError(messageOf(error));
      } finally {
        if (active) setSearching(false);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchText, user]);

  useEffect(() => {
    const client = supabase;
    const registration = draft.registration.trim();
    if (!jobFormOpen || !user || !client || registration.length < 2 || ownerDetailsEdited) return;

    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const { data: vehicle, error: vehicleError } = await client
          .from("vehicles")
          .select("id")
          .ilike("registration", registration)
          .maybeSingle();
        if (vehicleError) throw vehicleError;
        if (!vehicle) return;

        const { data: previousVisit, error: visitError } = await client
          .from("service_jobs")
          .select("owner_name, whatsapp_number")
          .eq("vehicle_id", vehicle.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (visitError) throw visitError;
        if (!active || !previousVisit) return;

        setDraft((current) => ({
          ...current,
          ownerName: current.ownerName || previousVisit.owner_name,
          whatsappNumber: current.whatsappNumber || previousVisit.whatsapp_number,
        }));
        setOwnerDetailsPrefilled(true);
      } catch (error) {
        if (active) setOwnerPrefillError(messageOf(error));
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draft.registration, jobFormOpen, ownerDetailsEdited, user]);

  useEffect(() => {
    if (!activeJob || !user) {
      setPhotoList([]);
      setPhotoListJobId("");
      setPhotoError("");
      return;
    }
    let active = true;
    setPhotoList([]);
    setPhotoListJobId("");
    setPhotoError("");
    listJobPhotos(user.id, activeJob.id)
      .then((photos) => {
        if (active) {
          setPhotoList(photos);
          setPhotoListJobId(activeJob.id);
        }
      })
      .catch((error: unknown) => {
        if (active) setPhotoError(messageOf(error));
      });
    return () => {
      active = false;
    };
  }, [activeJob, user]);

  const visibleJobs = useMemo(
    () => (filter === "all" ? jobs : jobs.filter((job) => job.status === filter)),
    [filter, jobs],
  );
  const openCount = jobs.filter((job) => OPEN_STATUSES.includes(job.status)).length;
  const activeHandover = activeJob?.service_handovers ?? null;

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setAuthError("");
    setAuthMessage("");
    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: authEmail.trim(), password: authPassword });
        if (error) throw error;
        if (!data.session) {
          setAuthMessage("Check your email to confirm your account, then sign in.");
          setAuthMode("signin");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword });
        if (error) throw error;
      }
    } catch (error) {
      setAuthError(messageOf(error));
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) setPageError(error.message);
  }

  function startNewJob(vehicle?: Vehicle, registration?: string) {
    const previousVisit = vehicle ? jobs.find((job) => job.vehicle_id === vehicle.id) : undefined;
    setSelectedVehicle(vehicle ?? null);
    setPendingDuplicate(null);
    setOwnerDetailsEdited(false);
    setOwnerDetailsPrefilled(Boolean(previousVisit));
    setOwnerPrefillError("");
    setDraft({
      ...EMPTY_DRAFT,
      registration: vehicle?.registration ?? registration?.toUpperCase() ?? "",
      make: vehicle?.make ?? "",
      model: vehicle?.model ?? "",
      ownerName: previousVisit?.owner_name ?? "",
      whatsappNumber: previousVisit?.whatsapp_number ?? "",
    });
    setJobFormOpen(true);
    setPageError("");
  }

  async function createJob(event?: FormEvent<HTMLFormElement>, allowDuplicate = false) {
    event?.preventDefault();
    if (!user || !supabase) return;
    setCreatingJob(true);
    setPageError("");
    try {
      let vehicle = selectedVehicle;
      const registration = draft.registration.trim().toUpperCase();
      if (vehicle && vehicle.registration !== registration) vehicle = null;
      if (!vehicle) {
        const { data: existing, error: lookupError } = await supabase
          .from("vehicles")
          .select("*")
          .eq("registration", registration)
          .maybeSingle();
        if (lookupError) throw lookupError;
        vehicle = (existing as Vehicle | null) ?? null;
        if (!vehicle) {
          const { data: createdVehicle, error: vehicleError } = await supabase
            .from("vehicles")
            .insert({
              advisor_id: user.id,
              registration,
              make: draft.make.trim(),
              model: draft.model.trim(),
            })
            .select("*")
            .single();
          if (vehicleError) throw vehicleError;
          vehicle = createdVehicle as Vehicle;
        }
      }
      const { data: openJobs, error: openJobsError } = await supabase
        .from("service_jobs")
        .select("id, job_ref, status")
        .eq("vehicle_id", vehicle.id)
        .in("status", OPEN_STATUSES);
      if (openJobsError) throw openJobsError;
      if (openJobs?.length && !(allowDuplicate && pendingDuplicate?.vehicleId === vehicle.id)) {
        setSelectedVehicle(vehicle);
        setPendingDuplicate({ vehicleId: vehicle.id, jobRef: openJobs[0].job_ref, status: openJobs[0].status as JobStatus });
        return;
      }
      const { error: jobError } = await supabase.from("service_jobs").insert({
        advisor_id: user.id,
        vehicle_id: vehicle.id,
        job_ref: makeJobRef(),
        owner_name: draft.ownerName.trim(),
        whatsapp_number: draft.whatsappNumber.trim(),
        odometer: Number(draft.odometer),
        requested_work: draft.requestedWork.trim(),
        promised_pickup_at: draft.promisedPickupAt ? new Date(draft.promisedPickupAt).toISOString() : null,
        service_notes: draft.serviceNotes.trim(),
        status: "checked_in",
      });
      if (jobError) throw jobError;
      setJobFormOpen(false);
      setPendingDuplicate(null);
      setSearchText("");
      setSelectedVehicle(null);
      await loadJobs();
    } catch (error) {
      setPageError(messageOf(error));
    } finally {
      setCreatingJob(false);
    }
  }

  async function changeStatus(job: ServiceJob, next: JobStatus, reason = "") {
    if (!supabase) return;
    setStatusSaving(true);
    setStatusError("");
    setPageError("");
    try {
      const { error } = await supabase
        .from("service_jobs")
        .update({ status: next, status_reason: reason.trim() || null })
        .eq("id", job.id);
      if (error) throw error;
      setStatusChange(null);
      setStatusReason("");
      await loadJobs();
      if (activeJob?.id === job.id) {
        const { data, error: refreshError } = await supabase
          .from("service_jobs")
          .select("*, vehicles(registration, make, model), status_history(*), service_handovers(*)")
          .eq("id", job.id)
          .single();
        if (refreshError) throw refreshError;
        const refreshed = data as ServiceJob;
        setActiveJob({
          ...refreshed,
          status_history: [...(refreshed.status_history ?? [])].sort(
            (a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime(),
          ),
        });
      }
    } catch (error) {
      setStatusError(messageOf(error));
    } finally {
      setStatusSaving(false);
    }
  }

  function requestStatusChange(job: ServiceJob, next: JobStatus) {
    setStatusError("");
    const reasonRequired = next === "on_hold" || (job.status === "ready" && next === "in_service");
    if (reasonRequired) {
      setStatusReason("");
      setStatusChange({ job, next });
      return;
    }
    void changeStatus(job, next);
  }

  async function handlePhotoFiles(files: FileList | null) {
    if (!files || !activeJob || !user) return;
    setPhotoBusy(true);
    setPhotoError("");
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
        await saveJobPhoto(user.id, activeJob.id, file);
      }
      setPhotoList(await listJobPhotos(user.id, activeJob.id));
    } catch (error) {
      setPhotoError(messageOf(error));
    } finally {
      setPhotoBusy(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  async function removePhoto(photoId: string) {
    if (!user || !activeJob) return;
    setPhotoError("");
    try {
      await deleteJobPhoto(user.id, activeJob.id, photoId);
      setPhotoList(await listJobPhotos(user.id, activeJob.id));
    } catch (error) {
      setPhotoError(messageOf(error));
    }
  }

  function openWhatsApp(job: ServiceJob) {
    const message = `Hello ${job.owner_name}, your ${job.vehicles.registration} (job ${job.job_ref}) is ready for pickup.`;
    setWhatsAppMessage(message);
    setWhatsAppError("");
    setWhatsAppJob(job);
  }

  function launchWhatsApp() {
    if (!whatsAppJob) return;
    const phone = whatsAppJob.whatsapp_number.replace(/\D/g, "");
    if (!phone) {
      setWhatsAppError("This job does not have a valid WhatsApp number.");
      return;
    }
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(whatsAppMessage)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setWhatsAppJob(null);
  }

  async function openHandoverReceipt(handover: ServiceHandover) {
    if (!supabase) return;
    const receiptWindow = window.open("about:blank", "_blank");
    if (!receiptWindow) {
      setPageError("Your browser blocked the receipt window. Allow pop-ups and try again.");
      return;
    }
    const { data, error } = await supabase.storage
      .from("service-handovers")
      .createSignedUrl(handover.pdf_path, 60);
    if (error) {
      receiptWindow.close();
      setPageError(error.message);
      return;
    }
    receiptWindow.location.replace(data.signedUrl);
  }

  function finishHandover() {
    setHandoverJob(null);
    setActiveJob(null);
    void loadJobs();
  }

  if (authLoading) {
    return <main className="loading-screen"><div className="spinner" /><span>Starting your service desk…</span></main>;
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="setup-screen">
        <div className="brand-mark"><Wrench size={21} /></div>
        <span className="eyebrow">SERVICE DESK · SECURE HANDOVER</span>
        <h1>Connect your showroom</h1>
        <p>Add your Supabase project URL and anon key to <code>.env</code>, then restart the dev server.</p>
        <pre>VITE_SUPABASE_URL=https://…supabase.co{"\n"}VITE_SUPABASE_ANON_KEY=…</pre>
        <small>Apply the migration in <code>supabase/migrations</code> before signing in.</small>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="brand-mark"><Wrench size={21} /></div>
          <span className="eyebrow">YOUR SHOWROOM, IN CONTROL</span>
          <h1>{authMode === "signin" ? "Welcome back" : "Create your advisor login"}</h1>
          <p>One clear view of every vehicle in your workshop.</p>
          <form onSubmit={submitAuth} className="stack-form">
            <label>Email address<input type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="you@showroom.com" /></label>
            <label>Password<input type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={6} required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="At least 6 characters" /></label>
            {authError && <p className="inline-error" role="alert">{authError}</p>}
            {authMessage && <p className="inline-success" role="status">{authMessage}</p>}
            <button className="button button-primary full-button" type="submit">{authMode === "signin" ? "Sign in" : "Create account"}<ArrowRight size={17} /></button>
          </form>
          <button className="text-button auth-switch" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthError(""); setAuthMessage(""); }}>
            {authMode === "signin" ? "New to the service desk? Create an account" : "Already have an account? Sign in"}
          </button>
          <div className="secure-note"><ShieldCheck size={15} /> Your service records are private to your advisor account.</div>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Service Desk home"><span className="brand-mark"><Wrench size={19} /></span><span>service<span className="brand-accent">desk</span></span></a>
        <div className="advisor-menu">
          <span className="advisor-avatar">{user.email?.slice(0, 1).toUpperCase() ?? "A"}</span>
          <span className="advisor-email">{user.email}</span>
          <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}><LogOut size={18} /></button>
        </div>
      </header>

      <main className="dashboard">
        <section className="welcome-row">
          <div>
            <span className="eyebrow">SHOWROOM SERVICE DESK</span>
            <h1>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}<span className="period">.</span></h1>
            <p>Your workshop at a glance. Every visit, accounted for.</p>
          </div>
          <button className="button button-primary new-job-button" onClick={() => startNewJob()}><Plus size={18} /> New service job</button>
        </section>

        <section className="search-panel">
          <div className="search-heading"><div><span className="section-kicker">QUICK CHECK-IN</span><h2>Find a vehicle</h2></div><span className="search-hint">Search by registration</span></div>
          <div className="search-box"><Search size={20} /><input value={searchText} onChange={(event) => { setSearchText(event.target.value); setSelectedVehicle(null); }} placeholder="e.g. MH 02 AB 1234" aria-label="Search vehicle registration" /></div>
          {searchText.trim().length > 0 && searchText.trim().length < 2 && <p className="search-hint below">Enter at least 2 characters to search.</p>}
          {searching && <p className="search-hint below">Searching vehicles…</p>}
          {searchText.trim().length >= 2 && !searching && (
            <div className="search-results">
              {vehicles.length === 0 ? (
                <div className="no-match"><span>No vehicle found for <strong>{searchText.toUpperCase()}</strong></span><button className="text-button" onClick={() => startNewJob(undefined, searchText)}>Add vehicle &amp; check in <ArrowRight size={15} /></button></div>
              ) : vehicles.map((vehicle) => {
                const openJob = jobs.find((job) => job.vehicle_id === vehicle.id && OPEN_STATUSES.includes(job.status));
                const visits = jobs.filter((job) => job.vehicle_id === vehicle.id).length;
                return (
                  <div className="vehicle-result" key={vehicle.id}>
                    <div className="vehicle-result-info"><strong>{vehicle.registration}</strong><span>{[vehicle.make, vehicle.model].filter(Boolean).join(" ") || "Vehicle"} · {visits} {visits === 1 ? "visit" : "visits"}</span>{openJob && <span className="open-warning"><Clock3 size={13} /> Open job {openJob.job_ref} · {STATUS_LABELS[openJob.status]}</span>}</div>
                    <button className="button button-small button-quiet" onClick={() => startNewJob(vehicle)}>New visit<ArrowRight size={15} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="jobs-section">
          <div className="section-header"><div><span className="section-kicker">THE WORKSHOP</span><h2>Service jobs <span className="count-badge">{jobs.length}</span></h2></div><span className="open-count"><span />{openCount} active</span></div>
          <div className="filter-row">
            <button className={`filter-chip ${filter === "all" ? "selected" : ""}`} onClick={() => setFilter("all")}>All jobs</button>
            {STATUS_ORDER.map((status) => <button key={status} className={`filter-chip ${filter === status ? "selected" : ""}`} onClick={() => setFilter(status)}>{STATUS_LABELS[status]}</button>)}
          </div>
          {pageError && <div className="error-banner" role="alert">{pageError}<button onClick={() => setPageError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
          {loadingJobs ? <div className="empty-state"><div className="spinner" /><p>Loading your jobs…</p></div> : visibleJobs.length ? (
            <div className="job-grid">{visibleJobs.map((job) => <JobCard key={job.id} job={job} onOpen={() => setActiveJob(job)} onWhatsApp={() => openWhatsApp(job)} />)}</div>
          ) : (
            <div className="empty-state"><div className="empty-icon"><Wrench size={23} /></div><h3>{filter === "all" ? "Your first check-in starts here" : `No ${STATUS_LABELS[filter].toLowerCase()} jobs`}</h3><p>{filter === "all" ? "Search a registration above or open a new service job." : "Jobs will appear here as their status changes."}</p>{filter === "all" && <button className="button button-quiet" onClick={() => startNewJob()}><Plus size={16} /> Start a service job</button>}</div>
          )}
        </section>
        <footer className="dashboard-footer"><ShieldCheck size={14} /> Private to your advisor account <span>·</span> Photos stay on this device</footer>
      </main>

      {jobFormOpen && (
        <Modal title="Open a service job" subtitle="Every visit gets its own job card." onClose={() => setJobFormOpen(false)}>
          <form className="job-form" onSubmit={(event) => void createJob(event)}>
            <div className="form-section-label">VEHICLE &amp; OWNER</div>
            <label>Vehicle registration<input required autoCapitalize="characters" value={draft.registration} onChange={(event) => { const registration = event.target.value.toUpperCase(); setDraft({ ...draft, registration, ownerName: "", whatsappNumber: "" }); setOwnerDetailsEdited(false); setOwnerDetailsPrefilled(false); setOwnerPrefillError(""); if (selectedVehicle && selectedVehicle.registration !== registration) setSelectedVehicle(null); setPendingDuplicate(null); }} placeholder="MH 02 AB 1234" /></label>
            {!selectedVehicle && <div className="form-row"><label>Make<input value={draft.make} onChange={(event) => setDraft({ ...draft, make: event.target.value })} placeholder="e.g. Honda" /></label><label>Model<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="e.g. City" /></label></div>}
            {selectedVehicle && <div className="selected-vehicle"><Check size={15} /> Existing vehicle · {[selectedVehicle.make, selectedVehicle.model].filter(Boolean).join(" ")}</div>}
            <div className="form-row"><label>Owner name<input required value={draft.ownerName} onChange={(event) => { setOwnerDetailsEdited(true); setOwnerDetailsPrefilled(false); setDraft({ ...draft, ownerName: event.target.value }); }} placeholder="Full name" /></label><label>WhatsApp number<input required type="tel" value={draft.whatsappNumber} onChange={(event) => { setOwnerDetailsEdited(true); setOwnerDetailsPrefilled(false); setDraft({ ...draft, whatsappNumber: event.target.value }); }} placeholder="Country code + number" /></label></div>
            {ownerDetailsPrefilled && <p className="prefill-note">Owner and WhatsApp details filled from the previous visit. You can edit them for this job.</p>}
            {ownerPrefillError && <p className="inline-error" role="alert">Could not load previous owner details: {ownerPrefillError}</p>}
            <div className="form-section-label">THIS VISIT</div>
            <div className="form-row"><label>Odometer<input required type="number" min="0" step="1" value={draft.odometer} onChange={(event) => setDraft({ ...draft, odometer: event.target.value })} placeholder="km" /></label><label>Promised pickup <span className="optional">(optional)</span><input type="datetime-local" value={draft.promisedPickupAt} onChange={(event) => setDraft({ ...draft, promisedPickupAt: event.target.value })} /></label></div>
            <label>Requested work<textarea required rows={2} value={draft.requestedWork} onChange={(event) => setDraft({ ...draft, requestedWork: event.target.value })} placeholder="What would the owner like us to do?" /></label>
            <label>Service notes <span className="optional">(optional)</span><textarea rows={2} value={draft.serviceNotes} onChange={(event) => setDraft({ ...draft, serviceNotes: event.target.value })} placeholder="Anything else the team should know" /></label>
            {pendingDuplicate && <div className="duplicate-warning" role="alert"><strong>Open job {pendingDuplicate.jobRef} · {STATUS_LABELS[pendingDuplicate.status]}</strong><span>This vehicle still has an active visit. Continue only if this is a separate return visit.</span><button type="button" className="text-button" disabled={creatingJob} onClick={() => void createJob(undefined, true)}>Create a separate visit anyway <ArrowRight size={15} /></button></div>}
            {pageError && <p className="inline-error" role="alert">{pageError}</p>}
            <div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setJobFormOpen(false)}>Cancel</button><button type="submit" className="button button-primary" disabled={creatingJob}>{creatingJob ? "Checking in…" : "Check in vehicle"}<ArrowRight size={16} /></button></div>
          </form>
        </Modal>
      )}

      {activeJob && (
        <Modal title={activeJob.job_ref} subtitle={`${activeJob.vehicles.registration} · ${[activeJob.vehicles.make, activeJob.vehicles.model].filter(Boolean).join(" ") || "Vehicle"}`} onClose={() => setActiveJob(null)} wide>
          <div className="job-detail">
            <div className="detail-status-line"><StatusPill status={activeJob.status} /><span>Opened {formatDate(activeJob.created_at)}</span></div>
            <div className="detail-columns">
              <div className="detail-main">
                <div className="detail-block"><span className="detail-label">OWNER</span><strong>{activeJob.owner_name}</strong><a href={`tel:${activeJob.whatsapp_number}`}>{activeJob.whatsapp_number}</a></div>
                <div className="detail-pair"><div className="detail-block"><span className="detail-label">ODOMETER</span><strong>{activeJob.odometer.toLocaleString()} km</strong></div><div className="detail-block"><span className="detail-label">PROMISED PICKUP</span><strong>{formatPickup(activeJob.promised_pickup_at)}</strong></div></div>
                <div className="detail-block"><span className="detail-label">REQUESTED WORK</span><p>{activeJob.requested_work}</p></div>
                {activeJob.service_notes && <div className="detail-block"><span className="detail-label">SERVICE NOTES</span><p>{activeJob.service_notes}</p></div>}
                {statusError && <p className="inline-error" role="alert">{statusError}</p>}
                <div className="detail-block"><span className="detail-label">STATUS HISTORY</span><div className="history-list">{activeJob.status_history.map((item) => <div className="history-row" key={item.id}><span className={`history-dot ${item.status}`} /><div><strong>{STATUS_LABELS[item.status]}</strong>{item.reason && <p>{item.reason}</p>}<small>Changed by {item.changed_by === user.id ? "you" : item.changed_by} · {formatDate(item.changed_at)}</small></div></div>)}</div></div>
              </div>
              <div className="detail-side">
                <div className="detail-block"><span className="detail-label">JOB PHOTOS <span className="local-only">· STORED ON THIS DEVICE</span></span>
                  <input ref={cameraInputRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(event) => void handlePhotoFiles(event.target.files)} />
                  <input ref={photoInputRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={(event) => void handlePhotoFiles(event.target.files)} />
                  <div className="photo-actions"><button className="button button-small button-quiet" onClick={() => cameraInputRef.current?.click()} disabled={photoBusy}>Take photo</button><button className="button button-small button-quiet" onClick={() => photoInputRef.current?.click()} disabled={photoBusy}><Upload size={15} /> Import</button></div>
                  <p className="photo-caption">Originals and thumbnails are saved in this browser, linked to this advisor and job only. They are never uploaded.</p>
                  {photoBusy && <p className="search-hint">Saving photo…</p>}
                  {photoError && <p className="inline-error">{photoError}</p>}
                  {photoListJobId === activeJob.id && photoList.length > 0 && <div className="photo-grid">{photoList.map((photo) => <PhotoThumbnail key={photo.id} photo={photo} onDelete={() => void removePhoto(photo.id)} />)}</div>}
                  {photoListJobId === activeJob.id && !photoList.length && !photoBusy && <div className="photo-empty">No photos on this job yet.</div>}
                </div>
              </div>
            </div>
            {activeJob.status === "handed_over" && activeHandover && <div className="handover-receipt-row"><span><FileText size={16} /> Signed handover saved · {formatDate(activeHandover.signed_at)}</span><button className="button button-small button-quiet" onClick={() => void openHandoverReceipt(activeHandover)}>View signed PDF</button></div>}
            <div className="detail-footer">
              <div className="status-actions">{nextStatuses(activeJob.status).map((next) => <button key={next} className={`button ${next === "ready" ? "button-primary" : "button-quiet"}`} onClick={() => requestStatusChange(activeJob, next)}>{next === "ready" ? <Check size={16} /> : <ArrowRight size={16} />}{next === "ready" ? "Ready for pickup" : `Move to ${STATUS_LABELS[next]}`}</button>)}</div>
              {activeJob.status === "ready" && <button className="button button-whatsapp" onClick={() => openWhatsApp(activeJob)}><MessageCircle size={16} /> WhatsApp owner</button>}
              {activeJob.status === "ready" && <button className="button button-primary handover-cta" onClick={() => setHandoverJob(activeJob)}><Check size={16} /> Complete handover</button>}
            </div>
          </div>
        </Modal>
      )}

      {statusChange && (
        <Modal title={`Move to ${STATUS_LABELS[statusChange.next]}`} subtitle={statusChange.next === "on_hold" ? "Add a reason so the team knows what is blocking this job." : "This ready job is returning to service. Record the reason."} onClose={() => setStatusChange(null)}>
          <form className="job-form" onSubmit={(event) => { event.preventDefault(); void changeStatus(statusChange.job, statusChange.next, statusReason); }}>
            <label>Reason<textarea required autoFocus rows={3} value={statusReason} onChange={(event) => setStatusReason(event.target.value)} placeholder={statusChange.next === "on_hold" ? "e.g. Waiting for a part" : "e.g. Owner requested an additional repair"} /></label>
            {statusError && <p className="inline-error" role="alert">{statusError}</p>}
            <div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setStatusChange(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={statusSaving}>{statusSaving ? "Saving…" : "Save status"}<ArrowRight size={16} /></button></div>
          </form>
        </Modal>
      )}

      {whatsAppJob && (
        <Modal title="Message the owner" subtitle="Review or edit the message before opening WhatsApp." onClose={() => setWhatsAppJob(null)}>
          <div className="job-form whatsapp-form">
            <div className="recipient-card"><MessageCircle size={18} /><div><strong>{whatsAppJob.owner_name}</strong><span>{whatsAppJob.whatsapp_number}</span></div></div>
            <label>Message<textarea rows={4} value={whatsAppMessage} onChange={(event) => setWhatsAppMessage(event.target.value)} /></label>
            {whatsAppError && <p className="inline-error" role="alert">{whatsAppError}</p>}
            <p className="photo-caption">WhatsApp will open with this message ready to send. Opening it does not mark the job as sent.</p>
            <div className="modal-actions"><button className="button button-quiet" onClick={() => setWhatsAppJob(null)}>Cancel</button><button className="button button-primary" onClick={launchWhatsApp}><MessageCircle size={16} /> Open WhatsApp</button></div>
          </div>
        </Modal>
      )}
      {handoverJob && user && <HandoverModal job={handoverJob} user={user} onClose={() => setHandoverJob(null)} onCompleted={finishHandover} />}
    </div>
  );
}

function JobCard({ job, onOpen, onWhatsApp }: { job: ServiceJob; onOpen: () => void; onWhatsApp: () => void }) {
  return (
    <article className="job-card" onClick={onOpen}>
      <div className="job-card-top"><StatusPill status={job.status} /><span className="job-ref">{job.job_ref}</span></div>
      <div className="job-vehicle"><h3>{job.vehicles.registration}</h3><span>{[job.vehicles.make, job.vehicles.model].filter(Boolean).join(" ") || "Vehicle"}</span></div>
      <div className="job-owner">{job.owner_name}<span> · {job.odometer.toLocaleString()} km</span></div>
      <p className="job-work">{job.requested_work}</p>
      <div className="job-card-bottom"><span className="pickup-time"><Clock3 size={14} /> {job.promised_pickup_at ? formatPickup(job.promised_pickup_at) : "Pickup not set"}</span><button className="card-arrow" aria-label={`Open job ${job.job_ref}`} onClick={(event) => { event.stopPropagation(); onOpen(); }}><ArrowRight size={18} /></button></div>
      {job.status === "ready" && <button className="card-whatsapp" onClick={(event) => { event.stopPropagation(); onWhatsApp(); }}><MessageCircle size={15} /> WhatsApp owner</button>}
    </article>
  );
}

function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`status-pill status-${status}`}><span />{STATUS_LABELS[status]}</span>;
}

function Modal({ title, subtitle, onClose, wide, children }: { title: string; subtitle: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><div><span className="eyebrow">SERVICE DESK</span><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button modal-close" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  );
}

function PhotoThumbnail({ photo, onDelete }: { photo: JobPhoto; onDelete: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(photo.thumbnail);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo.thumbnail]);
  return <div className="photo-thumb">{url && <img src={url} alt={photo.name} />}<button onClick={onDelete} aria-label={`Delete ${photo.name}`} title="Remove photo"><X size={14} /></button></div>;
}
