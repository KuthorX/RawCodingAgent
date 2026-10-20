def department_report(employees):
    """Summarise employees per department.

    employees: list of dicts with "name", "department", "salary" (int). The same person
    (same name AND department) may appear more than once; count them once, using their
    highest salary.

    Returns a list of rows, one per department, sorted by department name:
        {"department": str, "headcount": int, "total": int, "top": [names]}
    where "top" lists that department's people sorted by salary descending,
    then by name ascending.
    """
    best = {}
    for e in employees:
        key = (e["department"], e["name"])
        best[key] = max(best.get(key, e["salary"]), e["salary"])
    by_dept = {}
    for (dept, name), salary in best.items():
        by_dept.setdefault(dept, []).append((name, salary))
    rows = []
    for dept in sorted(by_dept):
        people = sorted(by_dept[dept], key=lambda p: (-p[1], p[0]))
        rows.append({
            "department": dept,
            "headcount": len(people),
            "total": sum(s for _, s in people),
            "top": [n for n, _ in people],
        })
    return rows
