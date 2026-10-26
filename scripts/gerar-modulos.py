"""Gera packages/central/src/modulos.gerado.ts (tabela → módulo) a partir do repositório tutts-backend.
Uso: python3 scripts/gerar-modulos.py ../tutts-backend"""
import os, re, sys

repo = sys.argv[1] if len(sys.argv) > 1 else "../tutts-backend"
mapa = {}
for raiz, _, arqs in os.walk(os.path.join(repo, "src")):
    for a in arqs:
        if not a.endswith(".js"):
            continue
        p = os.path.join(raiz, a)
        s = open(p, encoding="utf-8", errors="ignore").read()
        for t in re.findall(r'CREATE TABLE(?: IF NOT EXISTS)? "?([a-z_][a-z0-9_]*)"?\s*\(', s):
            partes = p.split(os.sep)
            mod = partes[partes.index("modules") + 1] if "modules" in partes else "outros"
            mapa.setdefault(t, mod)
saida = os.path.join(os.path.dirname(__file__), "..", "packages", "central", "src", "modulos.gerado.ts")
linhas = ["// Gerado a partir do repositório tutts-backend: tabela → módulo da Central que a cria.",
          "// Para atualizar: python3 scripts/gerar-modulos.py <caminho do tutts-backend>",
          "export const MODULO_DA_TABELA: Record<string, string> = {"]
linhas += [f'  {t}: "{mapa[t]}",' for t in sorted(mapa)]
linhas.append("};\n")
open(saida, "w").write("\n".join(linhas))
print(f"{len(mapa)} tabelas")
