import type { Database } from './database.ts';

/**
 * A deterministic demo dataset (a small online shop plus an org chart) used
 * by the Studio and `opusdb --demo`. Same seed, same rows, every time.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Ayşe', 'Mehmet', 'Elif', 'Emre', 'Zeynep', 'Can', 'Selin', 'Deniz', 'Hana', 'Kenji', 'Lucía', 'Mateo', 'Nora', 'Omar', 'Priya', 'Ravi', 'Sofia', 'Tariq', 'Uma', 'Viktor', 'Wen', 'Yara', 'Zoe', 'Burak', 'Ece', 'Kerem'];
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Öztürk', 'Tanaka', 'García', 'Müller', 'Rossi', 'Nguyen', 'Silva', 'Kim', 'Novak', 'Haddad', 'Patel'];
const PLACES: [string, string][] = [
  ['Istanbul', 'Türkiye'],
  ['Ankara', 'Türkiye'],
  ['İzmir', 'Türkiye'],
  ['Berlin', 'Germany'],
  ['Munich', 'Germany'],
  ['Paris', 'France'],
  ['Lyon', 'France'],
  ['Tokyo', 'Japan'],
  ['Osaka', 'Japan'],
  ['Madrid', 'Spain'],
  ['São Paulo', 'Brazil'],
  ['Toronto', 'Canada'],
  ['New York', 'USA'],
  ['Austin', 'USA'],
  ['Seoul', 'South Korea'],
  ['Nairobi', 'Kenya'],
];
const CATEGORIES: Record<string, [string, number][]> = {
  Keyboards: [['Mechanical Keyboard', 129], ['Low-Profile Keyboard', 89], ['Split Ergonomic Keyboard', 249], ['Compact 60% Keyboard', 99]],
  Audio: [['Studio Headphones', 199], ['Wireless Earbuds', 149], ['USB Microphone', 119], ['Bluetooth Speaker', 79]],
  Displays: [['27" 4K Monitor', 429], ['34" Ultrawide Monitor', 649], ['Portable Monitor', 229], ['Monitor Arm', 119]],
  Books: [['Database Internals', 49], ['Designing Data-Intensive Applications', 45], ['The Art of SQL', 39], ['Crafting Interpreters', 42]],
  Accessories: [['USB-C Hub', 59], ['Laptop Stand', 69], ['Desk Mat', 29], ['Webcam 4K', 139]],
  Storage: [['1TB NVMe SSD', 109], ['4TB External HDD', 129], ['64GB USB Drive', 19], ['NAS Enclosure', 399]],
};
const EDITIONS = ['', ' Pro', ' Mini', ' Max', ' SE'];
const STATUSES: [string, number][] = [
  ['delivered', 0.62],
  ['shipped', 0.14],
  ['paid', 0.1],
  ['pending', 0.07],
  ['cancelled', 0.05],
  ['returned', 0.02],
];

export const DEMO_SCHEMA = `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  city TEXT,
  country TEXT,
  tier TEXT CHECK (tier IN ('bronze', 'silver', 'gold')),
  joined_at TEXT
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL CHECK (price > 0),
  stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  ordered_at TEXT NOT NULL,
  status TEXT NOT NULL,
  total REAL
);
CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price REAL NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  manager_id INTEGER REFERENCES employees(id),
  salary INTEGER,
  hired_at TEXT
);
CREATE INDEX orders_customer ON orders (customer_id);
CREATE INDEX orders_date ON orders (ordered_at);
CREATE INDEX items_product ON order_items (product_id);
CREATE INDEX customers_country ON customers (country, city);
`;

export interface DemoSize {
  customers: number;
  orders: number;
}

/** Creates and fills the demo schema inside one transaction. */
export function loadDemo(db: Database, size: DemoSize = { customers: 600, orders: 5000 }): { rows: number; ms: number } {
  const t0 = performance.now();
  const r = rng(20250923);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  let rows = 0;
  db.exec('BEGIN');
  try {
    db.exec(DEMO_SCHEMA);
    const insCustomer = db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= size.customers; i++) {
      const first = pick(FIRST);
      const last = pick(LAST);
      const [city, country] = pick(PLACES);
      const tier = r() < 0.1 ? 'gold' : r() < 0.35 ? 'silver' : 'bronze';
      const joined = new Date(Date.UTC(2021, 0, 1) + Math.floor(r() * 1400) * 86400000).toISOString().slice(0, 10);
      const email = `${first}.${last}.${i}@example.com`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
      insCustomer.run([i, `${first} ${last}`, email, city, country, tier, joined]);
      rows++;
    }
    const insProduct = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?)');
    const products: { id: number; price: number }[] = [];
    let pid = 0;
    for (const [category, items] of Object.entries(CATEGORIES)) {
      for (const [base, price] of items) {
        for (const ed of EDITIONS) {
          if (ed && r() < 0.35) continue;
          pid++;
          const p = Math.round(price * (ed === ' Pro' ? 1.4 : ed === ' Max' ? 1.8 : ed === ' Mini' ? 0.7 : ed === ' SE' ? 0.85 : 1) * 100) / 100 - 0.01;
          const finalPrice = Math.round(p * 100) / 100;
          insProduct.run([pid, base + ed, category, finalPrice, Math.floor(r() * 400)]);
          products.push({ id: pid, price: finalPrice });
          rows++;
        }
      }
    }
    const insOrder = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)');
    const insItem = db.prepare('INSERT INTO order_items VALUES (?, ?, ?, ?)');
    const start = Date.UTC(2024, 0, 1);
    const span = Date.UTC(2025, 8, 1) - start;
    for (let o = 1; o <= size.orders; o++) {
      // a few loyal customers order much more often
      const customer = r() < 0.3 ? 1 + Math.floor(Math.pow(r(), 3) * size.customers) : 1 + Math.floor(r() * size.customers);
      // seasonality: more orders towards November/December
      let t = start + r() * span;
      if (r() < 0.25) t = Date.UTC(2024, 10, 1) + r() * 55 * 86400000;
      const when = new Date(Math.floor(t / 60000) * 60000).toISOString().replace('T', ' ').slice(0, 19);
      let x = r();
      let status = 'delivered';
      for (const [s, p] of STATUSES) {
        if (x < p) {
          status = s;
          break;
        }
        x -= p;
      }
      const n = 1 + Math.floor(Math.pow(r(), 2) * 5);
      const chosen = new Set<number>();
      let total = 0;
      const items: [number, number, number][] = [];
      for (let k = 0; k < n; k++) {
        const p = products[Math.floor(Math.pow(r(), 1.6) * products.length)];
        if (chosen.has(p.id)) continue;
        chosen.add(p.id);
        const q = 1 + Math.floor(Math.pow(r(), 3) * 4);
        total += q * p.price;
        items.push([p.id, q, p.price]);
      }
      insOrder.run([o, customer, when, status, Math.round(total * 100) / 100]);
      rows++;
      for (const [p, q, price] of items) {
        insItem.run([o, p, q, price]);
        rows++;
      }
    }
    const insEmp = db.prepare('INSERT INTO employees VALUES (?, ?, ?, ?, ?, ?)');
    const staff: [string, string, number | null, number][] = [
      ['Ada Lovelace', 'CEO', null, 310000],
      ['Grace Hopper', 'CTO', 1, 260000],
      ['Ayşe Yılmaz', 'VP Sales', 1, 210000],
      ['Linus Torvalds', 'Principal Engineer', 2, 240000],
      ['Emre Kaya', 'Engineering Manager', 2, 190000],
      ['Hana Tanaka', 'Engineering Manager', 2, 185000],
      ['Mateo García', 'Sales Manager', 3, 150000],
      ['Zeynep Demir', 'Database Engineer', 5, 160000],
      ['Kenji Nguyen', 'Backend Engineer', 5, 145000],
      ['Priya Patel', 'Frontend Engineer', 6, 140000],
      ['Can Öztürk', 'Frontend Engineer', 6, 132000],
      ['Nora Müller', 'SRE', 4, 158000],
      ['Omar Haddad', 'Account Executive', 7, 98000],
      ['Selin Çelik', 'Account Executive', 7, 102000],
      ['Viktor Novak', 'Intern', 8, 42000],
    ];
    staff.forEach(([name, title, mgr, salary], i) => {
      const hired = new Date(Date.UTC(2016, 0, 1) + Math.floor(r() * 3000) * 86400000).toISOString().slice(0, 10);
      insEmp.run([i + 1, name, title, mgr, salary, hired]);
      rows++;
    });
    db.exec('COMMIT');
  } catch (e) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw e;
  }
  return { rows, ms: performance.now() - t0 };
}
