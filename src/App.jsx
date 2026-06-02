import React, {useEffect, useRef, useState} from 'react'
import { X } from 'lucide-react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

const BRAND_NAME = 'LivrExpress 2'
const OBJECTIVE = 'livraison rapide de colis à Dakar'
const PRESET = 'Signal Brutaliste'
const ARG1 = 'livraison rapide.'
const ARG2 = 'disponible 24H/24.'
const ARG3 = 'garantit satisfait'
const CTA = 'Commander maintenant'

export default function App(){
  const appRef = useRef()
  const [showOrderForm, setShowOrderForm] = useState(false)

  useEffect(()=>{
    const ctx = gsap.context(()=>{
      // Navbar morph on scroll
      const nav = document.querySelector('.nav-pill')
      ScrollTrigger.create({
        start: 'top top+=80',
        onEnter: ()=> nav.classList.add('scrolled'),
        onLeaveBack: ()=> nav.classList.remove('scrolled')
      })

      // Hero entrance
      gsap.from('.hero-anim',{y:40,opacity:0,duration:1,ease:'power3.out',stagger:0.08})

      // Feature 1: stacked cards cycle
      const stack = document.querySelectorAll('.stack-item')
      let idx = 0
      const cycle = ()=>{
        const items = document.querySelectorAll('.stack-item')
        gsap.to(items,{y:"+=40",duration:0.6, ease:'cubic-bezier(.34,1.56,.64,1)', onComplete:()=>{
          // move last to front
          const container = document.querySelector('.stack')
          container.appendChild(container.firstElementChild)
          gsap.set(container.firstElementChild,{y:0})
        }})
      }
      let int = setInterval(cycle,3000)

      // Typewriter for feature 2
      const tw = document.querySelector('.typewriter')
      const text = tw?.dataset?.text || ARG2
      let p=0
      const cursor = document.querySelector('.tw-cursor')
      const type = ()=>{
        if(!tw) return
        if(p<=text.length){
          tw.textContent = text.slice(0,p)
          p++
          setTimeout(type,60)
        } else {
          // blink cursor
          gsap.to(cursor,{opacity:0,duration:0.6,repeat:-1,yoyo:true,ease:'power2.inOut'})
        }
      }
      type()

      // Planner cursor animation
      const plannerCursor = document.querySelector('.planner-cursor')
      const days = document.querySelectorAll('.planner-day')
      if(plannerCursor && days.length){
        let di = 0
        const move = ()=>{
          const target = days[di % days.length]
          const r = target.getBoundingClientRect()
          const parentR = target.parentElement.getBoundingClientRect()
          const x = r.left - parentR.left + r.width/2
          const y = r.top - parentR.top + r.height/2
          gsap.to(plannerCursor,{x,y,duration:0.6,ease:'power2.inOut',onComplete:()=>{
            gsap.to(target,{scale:0.95,duration:0.12,yoyo:true,repeat:1})
            di++
            if(di<days.length*2) setTimeout(move,800)
            else gsap.to(plannerCursor,{opacity:0,duration:0.4})
          }})
        }
        setTimeout(move,1000)
      }

      // Protocol stacking pin
      const cards = document.querySelectorAll('.protocol-card')
      cards.forEach((c,i)=>{
        ScrollTrigger.create({
          trigger: c,
          start: 'top top',
          pin: i!==cards.length-1,
          pinSpacing: false,
          onEnter: ()=>{
            if(i>0){
              gsap.to(cards[i-1],{scale:0.9,filter:'blur(20px)',opacity:0.5,duration:0.6})
            }
          }
        })
      })

      // Reveal philosophy
      gsap.utils.toArray('.reveal-line').forEach((el,idx)=>{
        gsap.from(el,{y:28,opacity:0,duration:0.8,delay:idx*0.08,ease:'power3.out',scrollTrigger:{trigger:el, start:'top 80%'}})
      })

      // cleanup
      return ()=>{
        clearInterval(int)
      }

    }, appRef)

    return ()=> ctx.revert()
  },[])

  return (
    <div ref={appRef} className="noise-overlay">
      <Nav onOrderClick={()=> setShowOrderForm(true)} />
      <main className="overflow-hidden">
        <Hero onOrderClick={()=> setShowOrderForm(true)} />
        <Features />
        <Philosophy />
        <Protocol />
        <Pricing />
        <Footer />
      </main>
      {showOrderForm && <OrderForm onClose={()=> setShowOrderForm(false)} />}
    </div>
  )
}

function Nav({onOrderClick}){
  return (
    <header className="fixed left-1/2 -translate-x-1/2 top-8 z-40 w-[90%] max-w-4xl nav-pill bg-white/0 text-black/90 px-6 py-3 flex items-center justify-between card-rounded transition-all duration-400">
      <div className="font-bold">LivrExpress 2</div>
      <nav className="hidden md:flex gap-6 text-sm text-slate-700">
        <a className="lift-hover">Fonctionnalités</a>
        <a className="lift-hover">Tarifs</a>
        <a className="lift-hover">A propos</a>
      </nav>
      <button onClick={onOrderClick} className="btn-magnetic bg-[var(--color-accent)] text-white px-4 py-2 rounded-full hidden md:inline-block">
        <span className="bg-slide" style={{background:'rgba(255,255,255,0.06)'}}></span>
        Commander
      </button>
    </header>
  )
}

function Hero({onOrderClick}){
  return (
    <section className="hero-height relative bg-cover bg-center" style={{backgroundImage:`url('/hero_delivery.png')`, backgroundSize:'cover', backgroundPosition:'center'}}>
      <div className="absolute inset-0 bg-gradient-to-t from-[rgba(17,17,17,0.6)] to-transparent"></div>
      <div className="container mx-auto h-full flex items-end">
        <div className="p-8 md:p-16 text-white max-w-2xl hero-anim">
          <h1 className="text-4xl md:text-7xl leading-tight font-bold">
            <span className="block">Livrez le</span>
            <span className="block text-[5rem] font-serif italic">Système.</span>
          </h1>
          <p className="mt-6 text-lg opacity-90">{BRAND_NAME} — {OBJECTIVE}</p>
          <div className="mt-8">
            <button onClick={onOrderClick} className="btn-magnetic px-6 py-3 rounded-full" style={{background:'var(--color-accent)',color:'#fff'}}>
              <span className="bg-slide" style={{background:'rgba(0,0,0,0.06)'}}></span>
              {CTA}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function Features(){
  return (
    <section className="py-20 px-6 container mx-auto">
      <h2 className="text-2xl mb-8">Fonctionnalités</h2>
      <div className="grid md:grid-cols-3 gap-8">
        <div className="card-rounded bg-[var(--color-primary)] p-6 shadow-lg stack">
          <h3 className="mb-4">Melangeur Diagnostique</h3>
          <div className="relative h-48 overflow-hidden">
            <div className="stack-item absolute inset-0 p-4 bg-white/90 card-rounded mb-3">{ARG1} — état A</div>
            <div className="stack-item absolute inset-0 top-6 left-6 p-4 bg-white/80 card-rounded">{ARG1} — état B</div>
            <div className="stack-item absolute inset-0 top-12 left-12 p-4 bg-white/60 card-rounded">{ARG1} — état C</div>
          </div>
        </div>
        <div className="card-rounded bg-[var(--color-bg)] p-6 shadow-lg">
          <h3 className="mb-4">Machine à Écrire Télémétrie</h3>
          <div className="bg-white/5 p-4 rounded-2xl">
            <div className="flex items-center gap-3 mb-2"><span className="w-2 h-2 rounded-full bg-[var(--color-accent)] pulse"></span><div>Flux en Direct</div></div>
            <div className="font-mono bg-black/90 text-green-200 p-3 rounded-md typewriter" data-text={ARG2}></div>
            <div className="tw-cursor mt-2 text-[var(--color-accent)]">|</div>
          </div>
        </div>
        <div className="card-rounded bg-white p-6 shadow-lg">
          <h3 className="mb-4">Planificateur Protocole Curseur</h3>
          <div className="grid grid-cols-7 gap-2 bg-[var(--color-bg)] p-4 rounded-2xl relative">
            {['L','M','M','J','V','S','D'].map((d,i)=> (
              <div key={d} className="planner-day bg-white/80 p-2 text-center card-rounded lift-hover">{d}</div>
            ))}
            <div className="planner-cursor absolute w-8 h-8 bg-[var(--color-accent)] rounded-full" style={{left:10,top:10}}></div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Philosophy(){
  return (
    <section className="py-16 bg-black text-white relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-black via-black/80 to-black z-0"></div>
      <div className="container mx-auto relative z-10 px-6">
        <p className="max-w-2xl reveal-line text-lg text-gray-300">La plupart des services de livraison se concentrent sur : vitesse superficielle et promesses génériques.</p>
        <h3 className="mt-6 text-4xl font-serif italic reveal-line">Nous nous concentrons sur : <span style={{color:'var(--color-accent)'}}>précision industrielle</span>.</h3>
      </div>
    </section>
  )
}

function Protocol(){
  return (
    <section className="py-12">
      <div className="container mx-auto px-6">
        <div className="protocol-card bg-white p-8 card-rounded-lg mb-4">
          <div className="font-mono text-sm mb-2">Étape 1</div>
          <h4 className="text-2xl">Réception et tri</h4>
          <p className="mt-3">Nous collectons et organisons les colis pour un routage optimal.</p>
        </div>
        <div className="protocol-card bg-white p-8 card-rounded-lg mb-4">
          <div className="font-mono text-sm mb-2">Étape 2</div>
          <h4 className="text-2xl">Assignation dynamique</h4>
          <p className="mt-3">Algorithmes en temps réel pour assigner le meilleur coursier.</p>
        </div>
        <div className="protocol-card bg-white p-8 card-rounded-lg mb-4">
          <div className="font-mono text-sm mb-2">Étape 3</div>
          <h4 className="text-2xl">Livraison et confirmation</h4>
          <p className="mt-3">Preuve de livraison et suivi jusqu'à complétion.</p>
        </div>
      </div>
    </section>
  )
}

function Pricing(){
  return (
    <section className="py-20 px-6 container mx-auto">
      <h2 className="text-2xl mb-8">Tarification</h2>
      <div className="grid md:grid-cols-3 gap-6">
        <div className="p-6 bg-white card-rounded shadow">
          <h4>Essentiel</h4>
          <p className="mt-2">Pour les particuliers — tarifs à la course.</p>
          <button className="mt-4 btn-magnetic px-4 py-2 rounded-full">Choisir</button>
        </div>
        <div className="p-8 bg-[var(--color-primary)] card-rounded shadow-lg transform scale-105">
          <h4>Performance</h4>
          <p className="mt-2">Pour commerces — SLA amélioré.</p>
          <button className="mt-4 bg-[var(--color-accent)] text-white px-4 py-2 rounded-full">Choisir</button>
        </div>
        <div className="p-6 bg-white card-rounded shadow">
          <h4>Entreprise</h4>
          <p className="mt-2">Solutions sur mesure et intégration API.</p>
          <button className="mt-4 btn-magnetic px-4 py-2 rounded-full">Contact</button>
        </div>
      </div>
    </section>
  )
}

function Footer(){
  return (
    <footer className="bg-black text-white big-rounded py-12 mt-12">
      <div className="container mx-auto px-6 grid md:grid-cols-3 gap-6">
        <div>
          <div className="font-bold text-xl">LivrExpress 2</div>
          <div className="mt-2 text-sm opacity-80">Livraison rapide de colis à Dakar</div>
        </div>
        <div className="text-sm">
          <div className="mb-2">Navigation</div>
          <div className="opacity-80">Fonctionnalités • Tarifs • Contact</div>
        </div>
        <div className="text-sm">
          <div className="mb-2">Statut</div>
          <div className="font-mono flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>Système opérationnel</div>
        </div>
      </div>
    </footer>
  )
}

function OrderForm({onClose}){
  const [formData, setFormData] = useState({name:'', email:'', phone:'', address:''})
  
  const handleChange = (e)=> {
    const {name, value} = e.target
    setFormData(prev => ({...prev, [name]: value}))
  }
  
  const handleSubmit = (e)=> {
    e.preventDefault()
    alert(`Commande de ${formData.name} enregistrée ! Nous vous contactons au ${formData.phone}`)
    onClose()
  }
  
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white card-rounded max-w-md w-full p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold">Commander</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-full">
            <X size={24} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-1">Nom complet</label>
            <input type="text" name="name" value={formData.name} onChange={handleChange} placeholder="Votre nom" required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2" style={{outline:'none', focusRing:'2px solid var(--color-accent)'}} />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Email</label>
            <input type="email" name="email" value={formData.email} onChange={handleChange} placeholder="exemple@email.com" required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2" />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Téléphone</label>
            <input type="tel" name="phone" value={formData.phone} onChange={handleChange} placeholder="+221 77 123 45 67" required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2" />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Adresse de livraison</label>
            <input type="text" name="address" value={formData.address} onChange={handleChange} placeholder="Adresse à Dakar" required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2" />
          </div>
          <button type="submit" className="w-full mt-6 py-3 rounded-full font-semibold transition-transform" style={{background:'var(--color-accent)', color:'white'}}>
            Confirmer la commande
          </button>
        </form>
      </div>
    </div>
  )
}
