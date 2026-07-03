import { useEffect, useState } from "react";
import type { InventoryItem } from "@mealplanner/shared";
import { api } from "../api/client";

const empty = { name: "", quantity: 1, unit: "unit", category: "other", expiresOn: "" };

export function Inventory() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [form, setForm] = useState({ ...empty });

  const load = () => api.inventory().then(setItems);
  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    await api.addItem({ ...form, expiresOn: form.expiresOn || null });
    setForm({ ...empty });
    load();
  }

  const soon = (d: string | null) =>
    d ? (new Date(d).getTime() - Date.now()) / 86400000 <= 3 : false;

  return (
    <div className="stack">
      <section className="card">
        <h2>What's in the fridge</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>Item</th><th>Qty</th><th>Unit</th><th>Category</th><th>Expires</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className={soon(i.expiresOn) ? "expiring" : ""}>
                <td>{i.name}</td>
                <td>{i.quantity}</td>
                <td>{i.unit}</td>
                <td>{i.category}</td>
                <td>{i.expiresOn ?? "—"}</td>
                <td>
                  <button onClick={async () => { await api.deleteItem(i.id); load(); }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Add an item</h2>
        <form className="row" onSubmit={add}>
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input type="number" step="any" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} />
          <input placeholder="Unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          <input placeholder="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          <input type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
          <button type="submit">Add</button>
        </form>
      </section>
    </div>
  );
}
