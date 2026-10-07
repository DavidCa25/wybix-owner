import {useRef,useState} from 'react';
import {View,Text} from 'react-native';
import {useRouter} from 'expo-router';
import {parseQr,savePairing} from '../lib/pairing';
import {WebQr} from './WebQr.web';
export default function Escanear(){const router=useRouter(),busy=useRef(false);const [error,setError]=useState('');async function read(data:string){if(busy.current)return;const parsed=parseQr(data);if(!parsed){setError('Ese código no es válido. Usa el QR de vinculación de tu punto de venta.');return;}busy.current=true;try{await savePairing(parsed);router.replace('/(auth)/registro');}catch{setError('No se pudo guardar la vinculación. Revisa el almacenamiento de Safari.');busy.current=false;}}return <View style={{flex:1,backgroundColor:'#0F1826'}}>{error?<Text accessibilityRole="alert" style={{color:'#ffbcaf',padding:16}}>{error}</Text>:null}<WebQr title="Vincular tu negocio" onRead={read} onClose={()=>router.back()}/></View>;}