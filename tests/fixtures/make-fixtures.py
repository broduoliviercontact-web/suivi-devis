"""Fabrique les devis PDF d'essai utilisés par les tests (données fictives).
   python3 make-fixtures.py   (nécessite reportlab et Pillow)"""
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw
import os
D = os.path.dirname(os.path.abspath(__file__))
W, H = A4

# 1. Désignation à gauche, colonnes Qté / Tarif / % / Total à droite, montants en deux morceaux, compléments, deux pages
c = canvas.Canvas(f"{D}/devis-colonnes.pdf", pagesize=A4)
c.setFont("Helvetica", 9); c.drawRightString(560, 810, "Email : contact@sonolux-location.fr")
c.setFont("Helvetica-Bold", 14); c.drawString(30, 760, "DEVIS")
c.setFont("Helvetica", 10); c.drawString(30, 735, "Notre Réf : DV-2026-0457"); c.drawString(30, 722, "Date : du 06/11/26 au 08/11/26")
y = 690; c.setFont("Helvetica-Bold", 9)
for x, t in [(330, "Qté"), (370, "Coef"), (425, "Tarif"), (480, "%"), (535, "Total")]: c.drawString(x, y, t)
c.setFont("Helvetica-Bold", 10); y -= 16; c.drawString(30, y, "LOCATION SONORISATION")
rows = [("Console Yamaha QL5", "1", "450", "315"), ("Enceinte L-Acoustics X12", "4", "90", "252"), ("Pied d'enceinte", "4", "8", "22,40"),
        ("Micro HF Shure ULXD2 B58", "6", "40", "168"), ("Câble XLR 10m", "20", "0", "0")]
c.setFont("Helvetica", 9)
for d, q, t, tot in rows:
    y -= 13; c.drawString(34, y, d); c.drawString(334, y, q); c.drawString(376, y, "1,00")
    c.drawString(428, y, t); c.drawString(428 + c.stringWidth(t, "Helvetica", 9), y, ",00 €")  # montant coupé en deux
    c.drawString(471, y, "30,00 %"); c.drawString(534, y, tot + ("" if "," in tot else ",00") + " €")
    if d.startswith("Pied"): y -= 12; c.drawString(36, y, "(noir, avec adaptateur)")
y -= 20; c.drawString(332, y, "Total LOCATION SONORISATION :"); c.drawString(530, y, "757,40 €")
c.drawString(250, 30, "Page 1/2"); c.showPage()
c.setFont("Helvetica", 9); y = 800
c.drawString(34, y, "Transport A/R"); c.drawString(334, y, "1"); c.drawString(376, y, "1,00"); c.drawString(428, y, "120,00 €"); c.drawString(534, y, "120,00 €")
y -= 12; c.drawString(34, y, "Livraison le jeudi 5 novembre matin, reprise le lundi 9")
y -= 12; c.drawString(34, y, "contact livraison Paul 06 00 00 00 00")
c.setFont("Helvetica-Bold", 10); c.drawString(440, 650, "TOTAL GENERAL")
c.setFont("Helvetica", 10); c.drawString(420, 630, "HT :"); c.drawRightString(560, 630, "877,40 €")
c.drawString(420, 615, "TVA (20%) :"); c.drawRightString(560, 615, "175,48 €"); c.drawString(420, 600, "TTC :"); c.drawRightString(560, 600, "1 052,88 €")
c.save()

# 2. Réf | Désignation | Qté | P.U. HT | Total HT, désignation sur deux lignes, totaux en bas
c = canvas.Canvas(f"{D}/devis-designation.pdf", pagesize=A4)
c.setFont("Helvetica-Bold", 16); c.drawString(40, 790, "STAGE PRO SAS"); c.setFont("Helvetica", 9); c.drawString(40, 776, "ventes@stagepro.fr")
c.setFont("Helvetica-Bold", 12); c.drawString(40, 740, "Devis N° D-2026-114")
y = 690; c.setFont("Helvetica-Bold", 9)
for x, t in [(40, "Réf."), (100, "Désignation"), (350, "Qté"), (400, "P.U. HT"), (480, "Total HT")]: c.drawString(x, y, t)
c.setFont("Helvetica", 9)
for ref, d, q, pu, tot, extra in [("PR-201", "Praticable Samia 2x1 m", "12", "18,00", "216,00", "hauteur 60 cm"), ("PR-310", "Escalier 3 marches", "2", "25,00", "50,00", None),
                                   ("JP-001", "Jupe de scène noire 6 m", "3", "12,50", "37,50", None)]:
    y -= 16; c.drawString(40, y, ref); c.drawString(100, y, d); c.drawRightString(365, y, q); c.drawRightString(445, y, pu + " €"); c.drawRightString(530, y, tot + " €")
    if extra: y -= 11; c.drawString(100, y, extra)
y -= 40; c.setFont("Helvetica-Bold", 10)
c.drawString(380, y, "Total HT"); c.drawRightString(530, y, "1 234,50 €"); y -= 14
c.drawString(380, y, "TVA 20 %"); c.drawRightString(530, y, "246,90 €"); y -= 14; c.drawString(380, y, "Total TTC"); c.drawRightString(530, y, "1 481,40 €")
c.save()

# 3. Scan : une image, aucun texte
img = Image.new("RGB", (1240, 1754), "white"); dr = ImageDraw.Draw(img)
for i, t in enumerate(["DEVIS", "1 Console Yamaha QL5   450,00", "Total HT 450,00"]): dr.text((100, 120 + i * 60), t, fill="black")
img.save(f"{D}/scan.png"); c = canvas.Canvas(f"{D}/devis-scan.pdf", pagesize=A4); c.drawImage(f"{D}/scan.png", 0, 0, W, H); c.save(); os.remove(f"{D}/scan.png")
print("ok")
