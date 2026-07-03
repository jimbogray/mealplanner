import { useEffect, useState } from "react";
import type { FamilyMember } from "@mealplanner/shared";
import { api } from "../api/client";

const empty = { name: "", phoneE164: "", role: "member" as const };

export function Family() {
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [form, setForm] = useState({ ...empty });

  const load = () => api.members().then(setMembers);
  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.phoneE164.trim()) return;
    await api.addMember(form);
    setForm({ ...empty });
    load();
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>Family members</h2>
        <table className="grid">
          <thead>
            <tr><th>Name</th><th>Phone</th><th>Role</th><th></th></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className={m.active ? "" : "inactive"}>
                <td>{m.name}</td>
                <td>{m.phoneE164}</td>
                <td>{m.role}</td>
                <td><button onClick={async () => { await api.deleteMember(m.id); load(); }}>✕</button></td>
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
