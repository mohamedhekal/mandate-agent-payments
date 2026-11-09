# Third-party software

## AG Grid Community — MIT
The data grids in the dashboard (Audit log, Transactions, Orders) use **AG Grid Community v32.3.3** by AG Grid Ltd.,
vendored unmodified (no CDN) in `public/vendor/ag-grid/` so the app keeps working offline and under a strict
Content-Security-Policy. The "no-style" build is used together with the shipped CSS (`ag-grid.min.css`,
`ag-theme-quartz.min.css`), re-themed to Mandate's palette through CSS variables in `public/style.css`.

Licence: MIT — see `public/vendor/ag-grid/LICENSE.txt`. Source: https://github.com/ag-grid/ag-grid · https://www.ag-grid.com/

Everything else in this repository is original work under the project's MIT licence (`LICENSE`).
