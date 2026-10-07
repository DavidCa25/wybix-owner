import {useEffect,useState} from 'react';
import {View,Text,Pressable} from 'react-native';
import {pos as t} from './ui';
export default function PwaInstallHint(){
 const [show,setShow]=useState(false);
 useEffect(()=>{const n=navigator as Navigator&{standalone?:boolean};const ios=/iphone|ipad|ipod/i.test(n.userAgent)||(n.platform==='MacIntel'&&n.maxTouchPoints>1);try{setShow(ios&&!n.standalone&&!matchMedia('(display-mode: standalone)').matches&&!localStorage.getItem('wybix-pos-install-dismissed'));}catch{}},[]);
 if(!show)return null;
 return <View style={{position:'absolute',left:12,right:12,bottom:100,backgroundColor:t.navy,borderRadius:14,padding:14,flexDirection:'row',gap:12,zIndex:1000}}><Text style={{flex:1,color:'#fff',fontFamily:'Wybix',fontSize:13}}>En Safari toca Compartir → Agregar a pantalla de inicio para abrir Wybix desde su icono.</Text><Pressable accessibilityRole="button" accessibilityLabel="Cerrar instrucciones de instalación" onPress={()=>{setShow(false);try{localStorage.setItem('wybix-pos-install-dismissed','1');}catch{}}}><Text style={{color:'#fff',padding:8}}>Cerrar</Text></Pressable></View>;
}
