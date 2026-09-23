export interface Example {
  id: string;
  title: string;
  blurb: string;
  sql: string;
}

/** Curated queries over the demo shop; each one exercises a different part of the engine. */
export const EXAMPLES: Example[] = [
  {
    id: 'top-customers',
    title: 'Top customers by revenue',
    blurb: 'Hash join, GROUP BY, Top-N sort',
    sql: `-- Who spends the most? (cancelled orders excluded)
SELECT c.name, c.country,
       count(*)               AS orders,
       round(sum(o.total), 2) AS revenue
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status <> 'cancelled'
GROUP BY c.id, c.name, c.country
ORDER BY revenue DESC
LIMIT 10;`,
  },
  {
    id: 'monthly',
    title: 'Monthly revenue with a running total',
    blurb: 'strftime(), window SUM() OVER, LAG()',
    sql: `WITH monthly AS (
  SELECT strftime('%Y-%m', ordered_at) AS month,
         round(sum(total), 2)         AS revenue
  FROM orders
  WHERE status IN ('paid', 'shipped', 'delivered')
  GROUP BY 1
)
SELECT month,
       revenue,
       round(sum(revenue) OVER (ORDER BY month), 2)  AS running_total,
       round(100.0 * (revenue - lag(revenue) OVER (ORDER BY month))
             / lag(revenue) OVER (ORDER BY month), 1) AS growth_pct
FROM monthly
ORDER BY month;`,
  },
  {
    id: 'rank',
    title: 'Best sellers per category',
    blurb: 'rank() OVER (PARTITION BY …), derived table',
    sql: `SELECT category, product, units, rnk
FROM (
  SELECT p.category, p.name AS product, sum(i.quantity) AS units,
         rank() OVER (PARTITION BY p.category ORDER BY sum(i.quantity) DESC) AS rnk
  FROM order_items i
  JOIN products p ON p.id = i.product_id
  GROUP BY p.category, p.name
) ranked
WHERE rnk <= 3
ORDER BY category, rnk;`,
  },
  {
    id: 'org',
    title: 'Org chart',
    blurb: 'WITH RECURSIVE over a self-referencing table',
    sql: `WITH RECURSIVE chain(id, name, title, depth, path) AS (
  SELECT id, name, title, 0, name FROM employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.id, e.name, e.title, c.depth + 1, c.path || ' › ' || e.name
  FROM employees e JOIN chain c ON e.manager_id = c.id
)
SELECT substr('                    ', 1, depth * 3) || name AS person, title, depth
FROM chain
ORDER BY path;`,
  },
  {
    id: 'mandelbrot',
    title: 'The Mandelbrot set, in SQL',
    blurb: 'Recursive CTE doing complex arithmetic',
    sql: `-- The classic from the SQLite docs; OpusDB renders it identically
WITH RECURSIVE
  xaxis(x) AS (VALUES(-2.0) UNION ALL SELECT x + 0.05 FROM xaxis WHERE x < 1.2),
  yaxis(y) AS (VALUES(-1.0) UNION ALL SELECT y + 0.1 FROM yaxis WHERE y < 1.0),
  m(iter, cx, cy, x, y) AS (
    SELECT 0, x, y, 0.0, 0.0 FROM xaxis, yaxis
    UNION ALL
    SELECT iter + 1, cx, cy, x*x - y*y + cx, 2.0*x*y + cy
    FROM m WHERE (x*x + y*y) < 4.0 AND iter < 28
  ),
  m2(iter, cx, cy) AS (SELECT max(iter), cx, cy FROM m GROUP BY cx, cy),
  a(cy, t) AS (
    SELECT cy, string_agg(substr(' .+*#', 1 + min(iter / 7, 4), 1), '' ORDER BY cx)
    FROM m2 GROUP BY cy
  )
SELECT string_agg(rtrim(t), char(10) ORDER BY cy) AS mandelbrot FROM a;`,
  },
  {
    id: 'never-ordered',
    title: 'Customers who never ordered',
    blurb: 'NOT EXISTS with a correlated subquery',
    sql: `SELECT c.name, c.city, c.joined_at
FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
ORDER BY c.joined_at DESC;`,
  },
  {
    id: 'index-plan',
    title: 'How an index changes the plan',
    blurb: 'EXPLAIN a lookup, then create an index',
    sql: `-- 1. No index on status yet: a full scan
EXPLAIN SELECT count(*) FROM orders WHERE status = 'returned';

-- 2. Build one (sorted bulk load)...
CREATE INDEX IF NOT EXISTS orders_status ON orders (status);

-- 3. ...and the same query becomes an index-only scan
EXPLAIN SELECT count(*) FROM orders WHERE status = 'returned';`,
  },
  {
    id: 'txn',
    title: 'Transactions and rollback',
    blurb: 'BEGIN / UPSERT / RETURNING / ROLLBACK',
    sql: `BEGIN;
-- give every gold customer's pending orders a 10% discount
UPDATE orders SET total = round(total * 0.9, 2)
WHERE status = 'pending'
  AND customer_id IN (SELECT id FROM customers WHERE tier = 'gold')
RETURNING id, total;
-- upsert: bump stock or insert a new product
INSERT INTO products (id, name, category, price, stock)
VALUES (1, 'Mechanical Keyboard', 'Keyboards', 129, 5)
ON CONFLICT (id) DO UPDATE SET stock = products.stock + excluded.stock
RETURNING id, name, stock;
ROLLBACK;  -- nothing above is kept
SELECT count(*) AS pending_orders FROM orders WHERE status = 'pending';`,
  },
  {
    id: 'basket',
    title: 'Frequently bought together',
    blurb: 'Self-join on order_items, HAVING',
    sql: `SELECT a.name AS product, b.name AS bought_with, count(*) AS times
FROM order_items x
JOIN order_items y ON y.order_id = x.order_id AND y.product_id > x.product_id
JOIN products a ON a.id = x.product_id
JOIN products b ON b.id = y.product_id
GROUP BY a.name, b.name
HAVING count(*) >= 12
ORDER BY times DESC
LIMIT 12;`,
  },
];
