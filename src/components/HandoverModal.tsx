import { useRef, useState } from "react";
import type { PointerEvent } from "react";
import { ArrowRight, Check, Eraser, ShieldCheck, X } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { createId } from "../lib/id";
import { supabase } from "../lib/supabase";
import type { ServiceJob } from "../types";

interface HandoverModalProps {
  job: ServiceJob;
  user: User;
  onClose: () => void;
  onCompleted: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The handover could not be saved.";
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not read the signature. Please sign again."));
    }, "image/png");
  });
}

export default function HandoverModal({ job, user, onClose, onCompleted }: HandoverModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const [signerName, setSignerName] = useState(job.owner_name);
  const [relationship, setRelationship] = useState<"owner" | "authorized_pickup">("owner");
  const [confirmed, setConfirmed] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  function getPoint(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
    };
  }

  function beginSignature(event: PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    const context = canvas.getContext("2d");
    if (!context) {
      setErrorMessage("Signature capture is unavailable in this browser.");
      return;
    }
    const point = getPoint(event);
    context.fillStyle = "#26352b";
    context.beginPath();
    context.arc(point.x, point.y, 3, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.strokeStyle = "#26352b";
    context.lineWidth = 6;
    context.lineCap = "round";
    context.lineJoin = "round";
    drawingRef.current = true;
    setHasSignature(true);
    setErrorMessage("");
  }

  function continueSignature(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    event.preventDefault();
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const point = getPoint(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function endSignature(event: PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
    setErrorMessage("");
  }

  async function completeHandover() {
    const canvas = canvasRef.current;
    if (!canvas || !supabase) {
      setErrorMessage("Handover storage is not configured.");
      return;
    }
    if (!signerName.trim() || !hasSignature || !confirmed) return;

    setSaving(true);
    setErrorMessage("");
    const uploadedPaths: string[] = [];
    try {
      const { jsPDF } = await import("jspdf");
      const signature = await canvasBlob(canvas);
      const signatureDataUrl = canvas.toDataURL("image/png");
      const signedAt = new Date();
      const pdf = new jsPDF();
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(19);
      pdf.text("Vehicle handover receipt", 20, 23);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(10);
      pdf.setTextColor(95, 105, 97);
      pdf.text(`Job reference: ${job.job_ref}`, 20, 34);
      pdf.text(`Vehicle registration: ${job.vehicles.registration}`, 20, 41);
      pdf.text(`Vehicle: ${[job.vehicles.make, job.vehicles.model].filter(Boolean).join(" ") || "Not recorded"}`, 20, 48);
      pdf.text(`Owner: ${job.owner_name}`, 20, 55);
      pdf.text(`Odometer: ${job.odometer.toLocaleString()} km`, 20, 62);
      pdf.text(`Requested work: ${job.requested_work}`, 20, 73, { maxWidth: 165 });
      pdf.text(`Pickup person: ${signerName.trim()}`, 20, 91);
      pdf.text(`Relationship: ${relationship === "owner" ? "Vehicle owner" : "Authorized pickup person"}`, 20, 98);
      pdf.text(`Handover date and time: ${signedAt.toLocaleString()}`, 20, 105);
      pdf.setFontSize(9);
      pdf.text(
        "Acknowledgment: I am the owner or authorized pickup person and confirm receipt of this vehicle.",
        20,
        119,
        { maxWidth: 165 },
      );
      pdf.setTextColor(45, 54, 47);
      pdf.setFont("helvetica", "bold");
      pdf.text("Pickup person signature", 20, 141);
      pdf.addImage(signatureDataUrl, "PNG", 20, 146, 96, 32);
      pdf.setDrawColor(220, 226, 220);
      pdf.line(20, 184, 190, 184);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.setTextColor(115, 124, 116);
      pdf.text(`Recorded by advisor: ${user.email ?? user.id}`, 20, 192);
      const pdfBlob = pdf.output("blob");

      const folder = `${user.id}/${job.id}/${createId()}`;
      const signaturePath = `${folder}/signature.png`;
      const pdfPath = `${folder}/handover.pdf`;
      const storage = supabase.storage.from("service-handovers");
      const signatureUpload = await storage.upload(signaturePath, signature, {
        contentType: "image/png",
        upsert: false,
      });
      if (signatureUpload.error) throw signatureUpload.error;
      uploadedPaths.push(signaturePath);

      const pdfUpload = await storage.upload(pdfPath, pdfBlob, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (pdfUpload.error) throw pdfUpload.error;
      uploadedPaths.push(pdfPath);

      const { error } = await supabase.rpc("complete_service_job_handover", {
        p_job_id: job.id,
        p_signer_name: signerName.trim(),
        p_signer_relationship: relationship,
        p_signature_path: signaturePath,
        p_pdf_path: pdfPath,
      });
      if (error) throw error;

      onCompleted();
    } catch (error) {
      const cleanupMessage = uploadedPaths.length
        ? await supabase.storage.from("service-handovers").remove(uploadedPaths).then(({ error: cleanupError }) =>
            cleanupError ? ` Uploaded files could not be cleaned up: ${cleanupError.message}` : "",
          )
        : "";
      setErrorMessage(`${getErrorMessage(error)}${cleanupMessage}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal modal-wide handover-modal" role="dialog" aria-modal="true" aria-label="Complete vehicle handover">
        <div className="modal-header">
          <div>
            <span className="eyebrow">CUSTOMER HANDOVER</span>
            <h2>Review &amp; sign</h2>
            <p>Check the vehicle details, then hand the phone to the person collecting it.</p>
          </div>
          <button className="icon-button modal-close" onClick={onClose} disabled={saving} aria-label="Close"><X size={19} /></button>
        </div>
        <div className="modal-content handover-content">
          <div className="handover-summary">
            <div><span>JOB REFERENCE</span><strong>{job.job_ref}</strong></div>
            <div><span>VEHICLE</span><strong>{job.vehicles.registration}</strong><small>{[job.vehicles.make, job.vehicles.model].filter(Boolean).join(" ") || "Vehicle"}</small></div>
            <div><span>OWNER</span><strong>{job.owner_name}</strong></div>
            <div><span>ODOMETER</span><strong>{job.odometer.toLocaleString()} km</strong></div>
            <div className="handover-work"><span>REQUESTED WORK</span><strong>{job.requested_work}</strong></div>
          </div>

          <div className="handover-fields">
            <label>Person collecting the vehicle
              <input required value={signerName} onChange={(event) => setSignerName(event.target.value)} placeholder="Full name" autoComplete="name" />
            </label>
            <label>Collecting as
              <select value={relationship} onChange={(event) => setRelationship(event.target.value === "authorized_pickup" ? "authorized_pickup" : "owner")}>
                <option value="owner">Vehicle owner</option>
                <option value="authorized_pickup">Authorized pickup person</option>
              </select>
            </label>
          </div>

          <div className="signature-section">
            <div className="signature-heading"><label htmlFor="signature-pad">Pickup person signature</label><button className="text-button" type="button" onClick={clearSignature}><Eraser size={14} /> Clear</button></div>
            <canvas
              ref={canvasRef}
              id="signature-pad"
              className="signature-pad"
              width={840}
              height={280}
              aria-label="Signature pad"
              onPointerDown={beginSignature}
              onPointerMove={continueSignature}
              onPointerUp={endSignature}
              onPointerCancel={endSignature}
            />
            <p className="signature-hint">Sign above using a finger or stylus. Clear and sign again if needed.</p>
          </div>

          <label className="handover-confirm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>I confirm I am the owner or authorized pickup person, have reviewed these details, and acknowledge receipt of this vehicle.</span>
          </label>
          <div className="handover-privacy"><ShieldCheck size={15} /> The signed receipt and signature are private to this advisor account.</div>
          {errorMessage && <p className="inline-error" role="alert">{errorMessage}</p>}
          <div className="modal-actions handover-actions">
            <button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="button" className="button button-primary" onClick={() => void completeHandover()} disabled={saving || !signerName.trim() || !hasSignature || !confirmed}>
              {saving ? "Saving signed handover…" : "Save & mark Handed over"}{!saving && <><Check size={16} /><ArrowRight size={16} /></>}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
