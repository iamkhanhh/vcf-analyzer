#!/bin/bash
# *******************************************
# INPUT: Canonical file
# *******************************************

canonical=$1
data_folder=$2
tmp_folder=$3
ouput=$4

# Configuration
workdir=$tmp_folder
header=$data_folder'/header.tsv'
TRANSCIPT_LENGTH=$data_folder'/transcript_length.txt'
MANE_FILE=$data_folder'/mane_table.tsv'
HGNC_FILE=$data_folder'/HGNC_JUL062023.tsv'

# Log file
mkdir -p $workdir
# rm -rf $workdir/*
cd $workdir
# Clean workdir but keep canonical file
basename_canonical=$(basename "$canonical")
find "$workdir" -mindepth 1 ! -name "$basename_canonical" -exec rm -rf {} +

logfile=$workdir/run.log
exec >$logfile 2>&1

less $canonical | grep -v "#" | awk -F"\t" '{split($8, a, "CSQ="); print $1"\t"$2"\t"$4"\t"$5"\t"a[2]}'  | awk -F"\t" 'BEGIN{OFS="\t"}{ split($5,a,","); col5 = $5; for (i in a){ $5=a[i]; print }}' | awk -F"\t" 'BEGIN{OFS="\t"}{split($5,a,"|"); col5= ""; for (i=1; i<=length(a); i++) {if(a[i] == ""){ a[i]="." };col5=col5"\t"a[i]}; print $1"\t"$2"\t"$3"\t"$4""col5}' > canonical.tsv

cat $header canonical.tsv > canonical_header.tsv

# Add Mane transcript
awk -F"\t" 'FNR==NR {a[$1] = $2; b[$1] = 1; next}{ if ( $1 == "#CHROM") { print $0"\tMANE_TR" } else { if(b[$8] == 1){ print $0"\t"a[$8]} else { print $0"\tNO_MANE" }}}' $MANE_FILE canonical_header.tsv > canonical_mane.tsv

# Add Transcript length
awk -F"\t" 'FNR==NR{a[$1"_"$3]=$2; next}{ if ( $1 == "#CHROM") { print $0"\ttranscript_length" }  else { if (length(a[$11"_"$8]) == 0) { print $0"\t0" } else { print $0"\t"a[$11"_"$8] } } }' $TRANSCIPT_LENGTH canonical_mane.tsv > canonical_mane_transcript.tsv

# Add HGNC
awk -F"\t" 'FNR==NR {HGNC_SYMBOL[$1] = $3; HGNC_PRE_SYMBOL[$1]= $4; b[$1] = 1; next}{if ( $1 == "#CHROM" ) { print $0"\tHGNC_SYMBOL\tHGNC_PRE_SYMBOL" } else { if (b[$28]==1) { print $0"\t"HGNC_SYMBOL[$28]"\t"HGNC_PRE_SYMBOL[$28] } else { print $0"\t.\t." } }}' $HGNC_FILE canonical_mane_transcript.tsv > canonical_mane_transcript_hgnc.tsv

mv -f canonical_mane_transcript_hgnc.tsv $ouput

# rm -rf $workdir