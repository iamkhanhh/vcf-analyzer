#!/bin/bash
set -e
# *******************************************
# INPUT: Canonical file
# *******************************************

canonical=$1
data_folder=$2
tmp_folder=$3
ouput=$4

# Configuration
workdir=$tmp_folder
target_csq_header=$data_folder'/header_v2.txt'
TRANSCIPT_LENGTH=$data_folder'/transcript_length.txt'
MANE_FILE=$data_folder'/mane_table.tsv'
HGNC_FILE=$data_folder'/HGNC_JUL062023.tsv'

# Log file
mkdir -p $workdir
cd $workdir
# Clean workdir but keep canonical file
basename_canonical=$(basename "$canonical")
find "$workdir" -mindepth 1 ! -name "$basename_canonical" -delete 2>/dev/null || true

logfile=$workdir/run.log
exec > >(tee -a "$logfile") 2>&1

generated_header=$workdir'/header.generated.tsv'
canonical_tsv=$workdir'/canonical.tsv'

python3 - "$canonical" "$generated_header" "$canonical_tsv" "$target_csq_header" <<'PY'
import re
import sys
from pathlib import Path

canonical = Path(sys.argv[1])
generated_header = Path(sys.argv[2])
canonical_tsv = Path(sys.argv[3])
target_header_spec = Path(sys.argv[4])

target_text = target_header_spec.read_text().strip()
target_match = re.search(r'Format: (.+?)">', target_text)
if not target_match:
    raise SystemExit("Could not parse target CSQ format from header_v2.txt")
target_fields = target_match.group(1).split("|")

csq_fields = None
with canonical.open() as fh:
    for line in fh:
        if line.startswith("##INFO=<ID=CSQ"):
            match = re.search(r'Format: (.+?)">', line.rstrip("\n"))
            if not match:
                raise SystemExit("Could not parse CSQ format from canonical header")
            csq_fields = match.group(1).split("|")
            break

if csq_fields is None:
    csq_fields = target_fields

generated_header.write_text("\t".join(["#CHROM", "POS", "REF", "ALT", *target_fields]) + "\n")

rows = []
with canonical.open() as fh:
    for raw_line in fh:
        if raw_line.startswith("#"):
            continue

        line = raw_line.rstrip("\n")
        if not line:
            continue

        cols = line.split("\t")
        if len(cols) < 8:
            continue

        chrom, pos, ref, alt, info = cols[0], cols[1], cols[3], cols[4], cols[7]
        match = re.search(r'(?:^|;)CSQ=([^;]+)', info)
        if not match:
            continue

        csq_entries = match.group(1).split(",")
        for entry in csq_entries:
            values = entry.split("|")
            if len(values) < len(csq_fields):
                values.extend([""] * (len(csq_fields) - len(values)))
            elif len(values) > len(csq_fields):
                values = values[:len(csq_fields)]

            mapped = {}
            for field_name, value in zip(csq_fields, values):
                mapped[field_name] = value if value != "" else "."

            row = [chrom, pos, ref, alt]
            for field_name in target_fields:
                row.append(mapped.get(field_name, "."))
            rows.append("\t".join(row))

canonical_tsv.write_text("\n".join(rows) + ("\n" if rows else ""))
PY

header_cols=$(awk -F"\t" 'NR==1{print NF}' "$generated_header")
data_cols=$(awk -F"\t" 'NR==1{print NF}' "$canonical_tsv")
if [ "$header_cols" -ne "$data_cols" ]; then
  echo "Header/data column mismatch: header=$header_cols data=$data_cols" >&2
  exit 1
fi

cat $generated_header "$canonical_tsv" > canonical_header.tsv

# Add Mane transcript
awk -F"\t" 'FNR==NR {a[$1] = $2; b[$1] = 1; next}{ if ( $1 == "#CHROM") { print $0"\tMANE_TR" } else { if(b[$8] == 1){ print $0"\t"a[$8]} else { print $0"\tNO_MANE" }}}' $MANE_FILE canonical_header.tsv > canonical_mane.tsv

# Add Transcript length
awk -F"\t" 'FNR==NR{a[$1"_"$3]=$2; next}{ if ( $1 == "#CHROM") { print $0"\ttranscript_length" }  else { if (length(a[$11"_"$8]) == 0) { print $0"\t0" } else { print $0"\t"a[$11"_"$8] } } }' $TRANSCIPT_LENGTH canonical_mane.tsv > canonical_mane_transcript.tsv

# Add HGNC
awk -F"\t" 'FNR==NR {HGNC_SYMBOL[$1] = $3; HGNC_PRE_SYMBOL[$1]= $4; b[$1] = 1; next}{if ( $1 == "#CHROM" ) { print $0"\tHGNC_SYMBOL\tHGNC_PRE_SYMBOL" } else { if (b[$28]==1) { print $0"\t"HGNC_SYMBOL[$28]"\t"HGNC_PRE_SYMBOL[$28] } else { print $0"\t.\t." } }}' $HGNC_FILE canonical_mane_transcript.tsv > canonical_mane_transcript_hgnc.tsv

mv -f canonical_mane_transcript_hgnc.tsv $ouput

# rm -rf $workdir
