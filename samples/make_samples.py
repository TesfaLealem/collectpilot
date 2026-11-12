"""Generate sample images for the vision demos: a bank transfer slip and a paper invoice.
Both are fictional. Run: python samples/make_samples.py  (needs Pillow)"""
import os
from datetime import date, timedelta
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))


def font(size, bold=False):
    for name in (["arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "DejaVuSans.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def slip():
    today = date.today()
    im = Image.new("RGB", (900, 1100), "#f7f6f1")
    d = ImageDraw.Draw(im)
    d.rectangle([40, 40, 860, 1060], outline="#333", width=3)
    d.text((70, 70), "ABAY NATIONAL BANK (sample)", font=font(38, True), fill="#143d6b")
    d.text((70, 125), "FUNDS TRANSFER CONFIRMATION", font=font(26, True), fill="#222")
    d.line([70, 170, 830, 170], fill="#333", width=2)
    rows = [
        ("Transaction reference", "FT26316B77"), ("Date", today.isoformat()), ("Time", "10:42:17"),
        ("Debit account name", "SHEGER ELECTRONICS"), ("Debit account", "1000 **** 4471"),
        ("Beneficiary name", "BLUE NILE DISTRIBUTORS"), ("Beneficiary account", "1000 **** 9020"),
        ("Amount", "ETB 198,000.00"), ("Amount in words", "One hundred ninety-eight thousand birr only"),
        ("Narration", "Payment INV-1053"), ("Status", "SUCCESSFUL"),
    ]
    y = 205
    for k, v in rows:
        d.text((70, y), k, font=font(24), fill="#555")
        d.text((400, y), v, font=font(24, k in ("Amount", "Transaction reference")), fill="#111")
        y += 62
    d.line([70, y + 10, 830, y + 10], fill="#333", width=2)
    d.text((70, y + 35), "This is a computer generated advice and requires no signature.", font=font(19), fill="#666")
    d.text((70, y + 70), "SAMPLE DOCUMENT FOR SOFTWARE TESTING. NOT A REAL TRANSACTION.", font=font(19, True), fill="#a33")
    im.rotate(1.2, expand=False, fillcolor="#ddd").save(os.path.join(HERE, "transfer_slip_sheger.png"))


def invoice():
    today = date.today()
    im = Image.new("RGB", (1000, 1300), "white")
    d = ImageDraw.Draw(im)
    d.text((60, 50), "BLUE NILE DISTRIBUTORS", font=font(40, True), fill="#1F4E79")
    d.text((60, 105), "Wholesale food and household goods. Addis Ababa (sample)", font=font(20), fill="#555")
    d.text((700, 50), "INVOICE", font=font(40, True), fill="#222")
    d.text((700, 110), "No: INV-1080", font=font(24), fill="#222")
    d.text((700, 145), f"Date: {today.isoformat()}", font=font(22), fill="#222")
    d.text((700, 178), f"Due: {(today + timedelta(days=30)).isoformat()}", font=font(22), fill="#222")
    d.text((60, 200), "Bill to:", font=font(22, True), fill="#222")
    d.text((60, 232), "Bahir Dar Family Mart", font=font(26), fill="#111")
    d.text((60, 268), "Kebele 04, Bahir Dar", font=font(20), fill="#555")
    d.rectangle([60, 330, 940, 380], fill="#E8F0F8")
    for x, t in ((75, "Description"), (520, "Qty"), (640, "Unit price"), (810, "Total")):
        d.text((x, 342), t, font=font(22, True), fill="#222")
    lines = [("Rice 25kg bag", 20, 2850.00), ("Cooking oil 5L (carton of 4)", 12, 3200.00), ("Sugar 50kg bag", 6, 5400.00), ("Laundry soap (carton of 48)", 5, 1980.00)]
    y, total = 400, 0.0
    for desc, q, u in lines:
        t = q * u
        total += t
        d.text((75, y), desc, font=font(22), fill="#111")
        d.text((520, y), str(q), font=font(22), fill="#111")
        d.text((640, y), f"{u:,.2f}", font=font(22), fill="#111")
        d.text((810, y), f"{t:,.2f}", font=font(22), fill="#111")
        d.line([60, y + 42, 940, y + 42], fill="#ddd", width=1)
        y += 58
    d.text((640, y + 20), "TOTAL (ETB)", font=font(24, True), fill="#111")
    d.text((810, y + 20), f"{total:,.2f}", font=font(24, True), fill="#111")
    d.text((60, y + 110), "Payment terms: 30 days. Bank transfer to Blue Nile Distributors.", font=font(20), fill="#555")
    d.text((60, 1220), "SAMPLE DOCUMENT FOR SOFTWARE TESTING.", font=font(18, True), fill="#a33")
    im.save(os.path.join(HERE, "invoice_photo_bahirdar.png"))
    print("invoice total", total)


slip()
invoice()
print("samples written")
