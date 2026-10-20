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
    rows = {}
    for e in employees:
        row = rows.setdefault(e["department"], {"department": e["department"], "headcount": 0, "total": 0, "top": []})
        row["headcount"] += 1
        row["total"] += e["salary"]
        row["top"].append(e["name"])
    for row in rows.values():
        row["top"].sort()
    return list(rows.values())
