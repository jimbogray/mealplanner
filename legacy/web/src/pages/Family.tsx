import { useEffect, useState } from "react";
import type { FamilyMember } from "@mealplanner/shared";
import { api } from "../api/client";

const empty = { name: "", phoneE164: "", email: "", role: "member" as const };

export function Family() {
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [form, setForm] = useState({ ...empty });
  const [error, setError] = useState<string | null>(null);

  const load = () => api.members().then(setMembers);
  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.phoneE164.trim()) return;
    setError(null);
    try {
      await api.addMember(form);
      setForm({ ...empty });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api.deleteMember(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member — admin role required");
    }
  }

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Family members</h2>
        <table className="grid">
          <thead>
            <tr><th>Name</th><th>Phone</th><th>Email</th><th>Role</th><th></th></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className={m.active ? "" : "inactive"}>
                <td>{m.name}</td>
                <td>{m.phoneE164}</td>
                <td>{m.email}</td>
                <td>{m.role}</td>
                <td><button onClick={() => remove(m.id)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Add a member</h2>
        <form className="row" onSubmit={add}>
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="+447700900123" value={form.phoneE164} onChange={(e) => setForm({ ...form, phoneE164: e.target.value })} />
          <input placeholder="Sign-in email (for admin role)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "member" })}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button type="submit">Add</button>
        </form>
      </section>
    </div>
  );
}
